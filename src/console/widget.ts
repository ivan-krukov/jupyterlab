// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  Kernel, KernelMessage, Session, nbformat
} from '@jupyterlab/services';

import {
  map, toArray
} from 'phosphor/lib/algorithm/iteration';

import {
  Message
} from 'phosphor/lib/core/messaging';

import {
  clearSignalData, defineSignal, ISignal
} from 'phosphor/lib/core/signaling';

import {
  Panel, PanelLayout
} from 'phosphor/lib/ui/panel';

import {
  Widget
} from 'phosphor/lib/ui/widget';

import {
  IEditorMimeTypeService, CodeEditor
} from '../codeeditor';

import {
  BaseCellWidget, CodeCellWidget, RawCellWidget,
  CodeCellModel, RawCellModel
} from '../notebook/cells';

import {
  OutputAreaWidget
} from '../notebook/output-area';

import {
  IRenderMime
} from '../rendermime';

import {
  ForeignHandler
} from './foreign';

import {
  ConsoleHistory, IConsoleHistory
} from './history';

import {
  IObservableVector, ObservableVector
} from '../common/observablevector';

/**
 * The class name added to console widgets.
 */
const CONSOLE_CLASS = 'jp-CodeConsole';

/**
 * The class name added to the console banner.
 */
const BANNER_CLASS = 'jp-CodeConsole-banner';

/**
 * The class name of a cell whose input originated from a foreign session.
 */
const FOREIGN_CELL_CLASS = 'jp-CodeConsole-foreignCell';

/**
 * The class name of the active prompt
 */
const PROMPT_CLASS = 'jp-CodeConsole-prompt';

/**
 * The class name of the panel that holds cell content.
 */
const CONTENT_CLASS = 'jp-CodeConsole-content';

/**
 * The class name of the panel that holds prompts.
 */
const INPUT_CLASS = 'jp-CodeConsole-input';

/**
 * The timeout in ms for execution requests to the kernel.
 */
const EXECUTION_TIMEOUT = 250;


/**
 * A widget containing a Jupyter console.
 *
 * #### Notes
 * The CodeConsole class is intended to be used within a ConsolePanel
 * instance. Under most circumstances, it is not instantiated by user code.
 */
export
class CodeConsole extends Widget {
  /**
   * Construct a console widget.
   */
  constructor(options: CodeConsole.IOptions) {
    super();
    this.addClass(CONSOLE_CLASS);

    // Create the panels that hold the content and input.
    let layout = this.layout = new PanelLayout();
    this._cells = new ObservableVector<BaseCellWidget>();
    this._content = new Panel();
    this._input = new Panel();
    let factory = this.contentFactory = options.contentFactory;
    this.rendermime = options.rendermime;
    this.session = options.session;
    this._mimeTypeService = options.mimeTypeService;

    // Add top-level CSS classes.
    this._content.addClass(CONTENT_CLASS);
    this._input.addClass(INPUT_CLASS);

    // Insert the content and input panes into the widget.
    layout.addWidget(this._content);
    layout.addWidget(this._input);

    // Create the banner.
    let model = new RawCellModel();
    model.value.text = '...';
    let banner = this.banner = factory.createBanner({
      model,
      contentFactory: factory.rawCellContentFactory
    }, this);
    banner.addClass(BANNER_CLASS);
    banner.readOnly = true;
    this._content.addWidget(banner);

    // Set the banner text and the mimetype.
    this._initialize();

    // Set up the foreign iopub handler.
    this._foreignHandler = factory.createForeignHandler({
      kernel: this.session.kernel,
      parent: this,
      cellFactory: () => this._createForeignCell(),
    });

    this._history = factory.createConsoleHistory({
      kernel: this.session.kernel
    });

    this.session.kernelChanged.connect(this._onKernelChanged, this);
  }

  /**
   * A signal emitted when the console finished executing its prompt.
   */
  readonly executed: ISignal<this, Date>;

  /**
   * A signal emitted when a new prompt is created.
   */
  readonly promptCreated: ISignal<this, CodeCellWidget>;

  /**
   * The content factory used by the console.
   */
  readonly contentFactory: CodeConsole.IContentFactory;

  /**
   * The rendermime instance used by the console.
   */
  readonly rendermime: IRenderMime;

  /**
   * The session used by the console.
   */
  readonly session: Session.ISession;

  /**
   * The console banner widget.
   */
  readonly banner: RawCellWidget;

  /**
   * The list of content cells in the console.
   *
   * #### Notes
   * This list does not include the banner or the prompt for a console.
   */
  get cells(): IObservableVector<BaseCellWidget> {
    return this._cells;
  }

  /*
   * The console input prompt.
   */
  get prompt(): CodeCellWidget | null {
    let inputLayout = (this._input.layout as PanelLayout);
    return inputLayout.widgets.at(0) as CodeCellWidget || null;
  }

  /**
   * Add a new cell to the content panel.
   *
   * @param cell - The cell widget being added to the content panel.
   *
   * #### Notes
   * This method is meant for use by outside classes that want to inject content
   * into a console. It is distinct from the `inject` method in that it requires
   * rendered code cell widgets and does not execute them.
   */
  addCell(cell: BaseCellWidget) {
    this._content.addWidget(cell);
    this._cells.pushBack(cell);
    cell.disposed.connect(this._onCellDisposed, this);
    this.update();
  }

  /**
   * Clear the code cells.
   */
  clear(): void {
    // Dispose all the content cells except the first, which is the banner.
    let cells = this._content.widgets;
    while (cells.length > 1) {
      cells.at(1).dispose();
    }
  }

  /**
   * Test whether the widget is disposed.
   */
  get isDisposed(): boolean {
    return this._foreignHandler === null;
  }

  /**
   * Dispose of the resources held by the widget.
   */
  dispose() {
    // Do nothing if already disposed.
    if (this.isDisposed) {
      return;
    }
    this._foreignHandler.dispose();
    this._foreignHandler = null;
    this._history.dispose();
    this._history = null;
    this._cells.clear();
    this._cells = null;
    super.dispose();
  }

  /**
   * Execute the current prompt.
   *
   * @param force - Whether to force execution without checking code
   * completeness.
   *
   * @param timeout - The length of time, in milliseconds, that the execution
   * should wait for the API to determine whether code being submitted is
   * incomplete before attempting submission anyway. The default value is `250`.
   */
  execute(force = false, timeout = EXECUTION_TIMEOUT): Promise<void> {
    if (this.session.status === 'dead') {
      return Promise.resolve(void 0);
    }

    let prompt = this.prompt;
    prompt.trusted = true;

    if (force) {
      // Create a new prompt before kernel execution to allow typeahead.
      this.newPrompt();
      return this._execute(prompt);
    }

    // Check whether we should execute.
    return this._shouldExecute(timeout).then(should => {
      if (this.isDisposed) {
        return;
      }
      if (should) {
        // Create a new prompt before kernel execution to allow typeahead.
        this.newPrompt();
        return this._execute(prompt);
      }
    });
  }

  /**
   * Inject arbitrary code for the console to execute immediately.
   *
   * @param code - The code contents of the cell being injected.
   *
   * @returns A promise that indicates when the injected cell's execution ends.
   */
  inject(code: string): Promise<void> {
    let cell = this._createForeignCell();
    cell.model.value.text = code;
    this.addCell(cell);
    return this._execute(cell);
  }

  /**
   * Insert a line break in the prompt.
   */
  insertLinebreak(): void {
    let prompt = this.prompt;
    let model = prompt.model;
    let editor = prompt.editor;
    // Insert the line break at the cursor position, and move cursor forward.
    let pos = editor.getCursorPosition();
    let offset = editor.getOffsetAt(pos);
    let text = model.value.text;
    model.value.text = text.substr(0, offset) + '\n' + text.substr(offset);
    pos = editor.getPositionAt(offset + 1);
    editor.setCursorPosition(pos);
  }

  /**
   * Serialize the output.
   */
  serialize(): nbformat.ICodeCell[] {
    let prompt = this.prompt;
    let layout = this._content.layout as PanelLayout;
    // Serialize content.
    let output = map(layout.widgets, widget => {
      return (widget as CodeCellWidget).model.toJSON() as nbformat.ICodeCell;
    });
    // Serialize prompt and return.
    return toArray(output).concat(prompt.model.toJSON() as nbformat.ICodeCell);
  }


  /**
   * Handle the DOM events for the widget.
   *
   * @param event - The DOM event sent to the widget.
   *
   * #### Notes
   * This method implements the DOM `EventListener` interface and is
   * called in response to events on the notebook panel's node. It should
   * not be called directly by user code.
   */
  handleEvent(event: Event): void {
    switch (event.type) {
    case 'keydown':
      this._evtKeyDown(event as KeyboardEvent);
      break;
    default:
      break;
    }
  }

  /**
   * Handle `after_attach` messages for the widget.
   */
  protected onAfterAttach(msg: Message): void {
    let node = this.node;
    node.addEventListener('keydown', this, true);
    // Create a prompt if necessary.
    if (!this.prompt) {
      this.newPrompt();
    } else {
      this.prompt.editor.focus();
      this.update();
    }
  }

  /**
   * Handle `before_detach` messages for the widget.
   */
  protected onBeforeDetach(msg: Message): void {
    let node = this.node;
    node.removeEventListener('keydown', this, true);
  }

  /**
   * Handle `'activate-request'` messages.
   */
  protected onActivateRequest(msg: Message): void {
    this.prompt.editor.focus();
    this.update();
  }

  /**
   * Make a new prompt.
   */
  protected newPrompt(): void {
    let prompt = this.prompt;
    let input = this._input;

    // Make the last prompt read-only, clear its signals, and move to content.
    if (prompt) {
      prompt.readOnly = true;
      prompt.removeClass(PROMPT_CLASS);
      clearSignalData(prompt.editor);
      (input.layout as PanelLayout).removeWidgetAt(0);
      this.addCell(prompt);
    }

    // Create the new prompt.
    let factory = this.contentFactory;
    let contentFactory = factory.codeCellContentFactory;
    let model = new CodeCellModel();
    let rendermime = this.rendermime;
    let options = { model, rendermime, contentFactory };
    prompt = factory.createPrompt(options, this);
    prompt.model.mimeType = this._mimetype;
    prompt.addClass(PROMPT_CLASS);
    this._input.addWidget(prompt);

    // Suppress the default "Enter" key handling.
    let editor = prompt.editor;
    editor.addKeydownHandler(this._onEditorKeydown);

    // Hook up history handling.
    editor.edgeRequested.connect(this.onEdgeRequest, this);
    editor.model.value.changed.connect(this.onTextChange, this);

    if (this.isAttached) {
      prompt.editor.focus();
      this.update();
    }
    this.promptCreated.emit(prompt);
  }

  /**
   * Handle an edge requested signal.
   */
  protected onEdgeRequest(editor: CodeEditor.IEditor, location: CodeEditor.EdgeLocation): Promise<void> {
    let prompt = this.prompt;
    let model = prompt.model;
    let source = prompt.model.value.text;

    if (location === 'top') {
      return this._history.back(source).then(value => {
        if (this.isDisposed || !value) {
          return;
        }
        if (model.value.text === value) {
          return;
        }
        this._setByHistory = true;
        model.value.text = value;
        editor.setCursorPosition({ line: 0, column: 0 });
      });
    }
    return this._history.forward(source).then(value => {
      if (this.isDisposed) {
        return;
      }
      let text = value || this._history.placeholder;
      if (model.value.text === text) {
        return;
      }
      this._setByHistory = true;
      model.value.text = text;
      editor.setCursorPosition(editor.getPositionAt(text.length));
    });
  }

  /**
   * Handle a text change signal from the editor.
   */
  protected onTextChange(): void {
    if (this._setByHistory) {
      this._setByHistory = false;
      return;
    }
    this._history.reset();
  }

  /**
   * Handle `update-request` messages.
   */
  protected onUpdateRequest(msg: Message): void {
    Private.scrollToBottom(this._content.node);
  }

  /**
   * Handle the `'keydown'` event for the widget.
   */
  private _evtKeyDown(event: KeyboardEvent): void {
    let editor = this.prompt.editor;
    if (event.keyCode === 13 && !editor.hasFocus()) {
      editor.focus();
    }
  }

  /**
   * Initialize the banner and mimetype.
   */
  private _initialize(): void {
    let kernel = this.session.kernel;
    if (!kernel) {
      return;
    }
    kernel.ready.then(() => {
      if (this.isDisposed) {
        return;
      }
      this._handleInfo(kernel.info);
    });
  }

  /**
   * Execute the code in the current prompt.
   */
  private _execute(cell: CodeCellWidget): Promise<void> {
    this._history.push(cell.model.value.text);
    cell.model.contentChanged.connect(this.update, this);
    let onSuccess = (value: KernelMessage.IExecuteReplyMsg) => {
      if (this.isDisposed) {
        return;
      }
      if (value && value.content.status === 'ok') {
        let content = value.content as KernelMessage.IExecuteOkReply;
        // Use deprecated payloads for backwards compatibility.
        if (content.payload && content.payload.length) {
          let setNextInput = content.payload.filter(i => {
            return (i as any).source === 'set_next_input';
          })[0];
          if (setNextInput) {
            let text = (setNextInput as any).text;
            // Ignore the `replace` value and always set the next cell.
            cell.model.value.text = text;
          }
        }
      }
      cell.model.contentChanged.disconnect(this.update, this);
      this.update();
      this.executed.emit(new Date());
    };
    let onFailure = () => {
      if (this.isDisposed) {
        return;
      }
      cell.model.contentChanged.disconnect(this.update, this);
      this.update();
    };
    return cell.execute(this.session.kernel).then(onSuccess, onFailure);
  }

  /**
   * Update the console based on the kernel info.
   */
  private _handleInfo(info: KernelMessage.IInfoReply): void {
    let layout = this._content.layout as PanelLayout;
    let banner = layout.widgets.at(0) as RawCellWidget;
    banner.model.value.text = info.banner;
    let lang = info.language_info as nbformat.ILanguageInfoMetadata;
    this._mimetype = this._mimeTypeService.getMimeTypeByLanguage(lang);
    if (this.prompt) {
      this.prompt.model.mimeType = this._mimetype;
    }
  }

  /**
   * Create a new foreign cell.
   */
  private _createForeignCell(): CodeCellWidget {
    let factory = this.contentFactory;
    let contentFactory = factory.codeCellContentFactory;
    let model = new CodeCellModel();
    let rendermime = this.rendermime;
    let options = { model, rendermime, contentFactory };
    let cell = factory.createForeignCell(options, this);
    cell.readOnly = true;
    cell.model.mimeType = this._mimetype;
    cell.addClass(FOREIGN_CELL_CLASS);
    return cell;
  }

  /**
   * Handle cell disposed signals.
   */
  private _onCellDisposed(sender: Widget, args: void): void {
    if (!this.isDisposed) {
      this._cells.remove(sender as CodeCellWidget);
    }
  }

  /**
   * Test whether we should execute the prompt.
   */
  private _shouldExecute(timeout: number): Promise<boolean> {
    let prompt = this.prompt;
    let model = prompt.model;
    let code = model.value.text + '\n';
    return new Promise<boolean>((resolve, reject) => {
      let timer = setTimeout(() => { resolve(true); }, timeout);
      this.session.kernel.requestIsComplete({ code }).then(isComplete => {
        clearTimeout(timer);
        if (this.isDisposed) {
          resolve(false);
        }
        if (isComplete.content.status !== 'incomplete') {
          resolve(true);
          return;
        }
        model.value.text = code + isComplete.content.indent;
        let editor = prompt.editor;
        let pos = editor.getPositionAt(model.value.text.length);
        editor.setCursorPosition(pos);
        resolve(false);
      }).catch(() => { resolve(true); });
    });
  }

  /**
   * Handle a keydown event on an editor.
   */
  private _onEditorKeydown(editor: CodeEditor.IEditor, event: KeyboardEvent) {
    // Suppress "Enter" events.
    return event.keyCode === 13;
  }

  /**
   * Handle a change to the kernel.
   */
  private _onKernelChanged(sender: Session.ISession, kernel: Kernel.IKernel): void {
    this.clear();
    this._initialize();
    this._history.kernel = kernel;
    this._foreignHandler.kernel = kernel;
    this.newPrompt();
  }

  private _mimeTypeService: IEditorMimeTypeService;
  private _cells: IObservableVector<BaseCellWidget> = null;
  private _content: Panel = null;
  private _foreignHandler: ForeignHandler =  null;
  private _history: IConsoleHistory = null;
  private _input: Panel = null;
  private _mimetype = 'text/x-ipython';
  private _setByHistory = false;
}


// Define the signals for the `CodeConsole` class.
defineSignal(CodeConsole.prototype, 'executed');
defineSignal(CodeConsole.prototype, 'promptCreated');


/**
 * A namespace for CodeConsole statics.
 */
export
namespace CodeConsole {
  /**
   * The initialization options for a console widget.
   */
  export
  interface IOptions {
    /**
     * The content factory for a console widget.
     */
    contentFactory: IContentFactory;

    /**
     * The mime renderer for the console widget.
     */
    rendermime: IRenderMime;

    /**
     * The session for the console widget.
     */
    session: Session.ISession;

    /**
     * The service used to look up mime types.
     */
    mimeTypeService: IEditorMimeTypeService;
  }

  /**
   * A content factory for console children.
   */
  export
  interface IContentFactory {
    /**
     * The editor factory.
     */
    readonly editorFactory: CodeEditor.Factory;

    /**
     * The factory for code cell widget content.
     */
    readonly codeCellContentFactory: CodeCellWidget.IContentFactory;

    /**
     * The factory for raw cell widget content.
     */
    readonly rawCellContentFactory: BaseCellWidget.IContentFactory;

    /**
     * The history manager for a console widget.
     */
    createConsoleHistory(options: ConsoleHistory.IOptions): IConsoleHistory;

    /**
     * The foreign handler for a console widget.
     */
    createForeignHandler(options: ForeignHandler.IOptions):
    ForeignHandler;

    /**
     * Create a new banner widget.
     */
    createBanner(options: RawCellWidget.IOptions, parent: CodeConsole): RawCellWidget;

    /**
     * Create a new prompt widget.
     */
    createPrompt(options: CodeCellWidget.IOptions, parent: CodeConsole): CodeCellWidget;

    /**
     * Create a code cell whose input originated from a foreign session.
     */
    createForeignCell(options: CodeCellWidget.IOptions, parent: CodeConsole): CodeCellWidget;
  }

  /**
   * Default implementation of `IContentFactory`.
   */
  export
  class ContentFactory implements IContentFactory {
    /**
     * Create a new content factory.
     */
    constructor(options: ContentFactory.IOptions) {
      let editorFactory = options.editorFactory;
      let outputAreaContentFactory = (options.outputAreaContentFactory ||
        OutputAreaWidget.defaultContentFactory
      );
      this.codeCellContentFactory = (options.codeCellContentFactory ||
        new CodeCellWidget.ContentFactory({
          editorFactory,
          outputAreaContentFactory
        })
      );
      this.rawCellContentFactory = (options.rawCellContentFactory ||
        new RawCellWidget.ContentFactory({ editorFactory })
      );
    }

    /**
     * The editor factory.
     */
    readonly editorFactory: CodeEditor.Factory;

    /**
     * The factory for code cell widget content.
     */
    readonly codeCellContentFactory: CodeCellWidget.IContentFactory;

    /**
     * The factory for raw cell widget content.
     */
    readonly rawCellContentFactory: BaseCellWidget.IContentFactory;

    /**
     * The history manager for a console widget.
     */
    createConsoleHistory(options: ConsoleHistory.IOptions): IConsoleHistory {
      return new ConsoleHistory(options);
    }

    /**
     * The foreign handler for a console widget.
     */
    createForeignHandler(options: ForeignHandler.IOptions):
    ForeignHandler {
      return new ForeignHandler(options);
    }
    /**
     * Create a new banner widget.
     */
    createBanner(options: RawCellWidget.IOptions, parent: CodeConsole): RawCellWidget {
      return new RawCellWidget(options);
    }

    /**
     * Create a new prompt widget.
     */
    createPrompt(options: CodeCellWidget.IOptions, parent: CodeConsole): CodeCellWidget {
      return new CodeCellWidget(options);
    }

    /**
     * Create a new code cell widget for an input from a foreign session.
     */
    createForeignCell(options: CodeCellWidget.IOptions, parent: CodeConsole): CodeCellWidget {
      return new CodeCellWidget(options);
    }
  }

  /**
   * The namespace for `ContentFactory` class statics.
   */
  export
  namespace ContentFactory {
    /**
     * An initialize options for `ContentFactory`.
     */
    export
    interface IOptions {
      /**
       * The editor factory.
       */
      editorFactory: CodeEditor.Factory;

      /**
       * The factory for output area content.
       */
      outputAreaContentFactory?: OutputAreaWidget.IContentFactory;

      /**
       * The factory for code cell widget content.  If given, this will
       * take precedence over the `outputAreaContentFactory`.
       */
      codeCellContentFactory?: CodeCellWidget.IContentFactory;

      /**
       * The factory for raw cell widget content.
       */
      rawCellContentFactory?: BaseCellWidget.IContentFactory;
    }
  }
}


/**
 * A namespace for console widget private data.
 */
namespace Private {
  /**
   * Jump to the bottom of a node.
   *
   * @param node - The scrollable element.
   */
  export
  function scrollToBottom(node: HTMLElement): void {
    node.scrollTop = node.scrollHeight - node.clientHeight;
  }
}
