const Event = require('./Event');
const EventTarget = require('./EventTarget');
const HeadersContainer = require('./HeadersContainer');

function throwError(type, text = '') {
  const exception = new Error(text);
  exception.name = type;
  throw exception;
}

/**
 * MockXhr supports:
 *  - events and states
 *  - open(), setRequestHeader(), send() and abort()
 *  - upload and download progress events
 *  - response status, statusText, headers and body
 *  - simulating a network error
 *  - simulating a request time out
 *
 * MockXhr does not support:
 * - synchronous requests (async == false)
 * - parsing the url and setting the username and password
 * - the timeout attribute (call MockXhr.setRequestTimeout() to trigger a timeout)
 * - withCredentials
 * - responseUrl (the final request url with redirects)
 * - Setting responseType (only the empty string responseType is used)
 * - overrideMimeType
 * - responseXml
 */
class MockXhr extends EventTarget {
  /**
   * Constructor
   */
  constructor() {
    super();
    this._readyState = MockXhr.UNSENT;
    this.requestHeaders = new HeadersContainer();
    this._upload = new EventTarget(this);
    this._response = this._networkErrorResponse();

    // Hook for XMLHttpRequest creation
    if (typeof MockXhr.onCreate === 'function') {
      MockXhr.onCreate(this);
    }
  }

  /**
   * Set the request method and url.
   * https://xhr.spec.whatwg.org/#the-open()-method
   *
   * @param {string} method request HTTP method (GET, POST, etc.)
   * @param {string} url request url
   */
  open(method, url) {
    if (this._methodForbidden(method)) {
      throwError('SecurityError', `Method "${method}" forbidden.`);
    }
    method = normalizeMethodName(method);
    // Skip parsing the url and setting the username and password

    this._terminateRequest();

    // Set variables
    this._sendFlag = false;
    this._uploadListenerFlag = false;
    this.method = method;
    this.url = url;
    this.requestHeaders.reset();
    this._response = this._networkErrorResponse();
    if (this._readyState !== MockXhr.OPENED) {
      this._readyState = MockXhr.OPENED;
      this._fireReadyStateChange();
    }
  }

  /**
   * Add a request header value.
   * https://xhr.spec.whatwg.org/#the-setrequestheader()-method
   *
   * @param {string} name header name
   * @param {string} value header value
   */
  setRequestHeader(name, value) {
    if (this._readyState !== MockXhr.OPENED || this._sendFlag) {
      throwError('InvalidStateError');
    }
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new SyntaxError();
    }

    if (!isForbiddenRequestHeader(name)) {
      // Normalize value
      value = value.trim();
      this.requestHeaders.addHeader(name, value);
    }
  }

  /**
   * Initiate the request.
   * https://xhr.spec.whatwg.org/#the-send()-method
   *
   * @param {*} body request body
   */
  send(body = null) {
    if (this._readyState !== MockXhr.OPENED || this._sendFlag) {
      throwError('InvalidStateError');
    }
    if (this.method === 'GET' || this.method === 'HEAD') {
      body = null;
    }

    if (body !== null) {
      let extractedContentType = null;

      // Document body type not supported

      // https://fetch.spec.whatwg.org/#concept-bodyinit-extract
      {
        let contentType = null;
        if (typeof body === 'string') {
          contentType = 'text/plain;charset=UTF-8';
        } else if (body.type) {
          // As specified for Blob
          contentType = body.type;
        }

        // BufferSource, FormData, etc. not handled specially
        extractedContentType = contentType;
      }

      if (this.requestHeaders.getHeader('Content-Type') === null && extractedContentType !== null) {
        this.requestHeaders.addHeader('Content-Type', extractedContentType);
      }
    }

    this._uploadListenerFlag = this._upload.hasListeners();
    this.body = body;
    this._uploadCompleteFlag = this.body === null;
    this._timedOutFlag = false;
    this._sendFlag = true;

    this._fireEvent('loadstart', 0, 0);
    if (!this._uploadCompleteFlag && this._uploadListenerFlag) {
      this._fireUploadEvent('loadstart', 0, this._getRequestBodySize());
    }

    // Other interactions are done through the mock's response methods
    if (this._readyState !== MockXhr.OPENED || !this._sendFlag) {
      return;
    }

    // Hook for XMLHttpRequest.send(). Execute in an empty callstack
    if (typeof this.onSend === 'function') {
      // Save the callback in case it changes before it has a chance to run
      const { onSend } = this;
      setTimeout(() => onSend.call(this, this), 0);
    }
    if (typeof MockXhr.onSend === 'function') {
      // Save the callback in case it changes before it has a chance to run
      const { onSend } = MockXhr;
      setTimeout(() => onSend.call(this, this), 0);
    }
  }

  /**
   * Abort the request.
   * https://xhr.spec.whatwg.org/#the-abort()-method
   */
  abort() {
    this._terminateRequest();

    if ((this._readyState === MockXhr.OPENED && this._sendFlag)
      || this._readyState === MockXhr.HEADERS_RECEIVED
      || this._readyState === MockXhr.LOADING) {
      this._requestErrorSteps('abort');
    }

    if (this._readyState === MockXhr.DONE) {
      // No readystatechange event is dispatched.
      this._readyState = MockXhr.UNSENT;
      this._response = this._networkErrorResponse();
    }
  }

  _networkErrorResponse() {
    return {
      type: 'error',
      status: 0,
      statusMessage: '',
      headers: new HeadersContainer(),
      body: null,
    };
  }

  _isNetworkErrorResponse() {
    return this._response.type === 'error';
  }

  _terminateRequest() {
    delete this.method;
    delete this.url;
  }

  _getRequestBodySize() {
    if (!this.body) {
      return 0;
    }
    return this.body.size ? this.body.size : this.body.length;
  }

  /**
   * Get a response header value.
   * https://xhr.spec.whatwg.org/#dom-xmlhttprequest-getresponseheader
   *
   * @param {string} name header name
   * @return {string} header value
   */
  getResponseHeader(name) {
    return this._response.headers.getHeader(name);
  }

  /**
   * Get all response headers as a string.
   * https://xhr.spec.whatwg.org/#dom-xmlhttprequest-getallresponseheaders
   *
   * @return {string} concatenated headers
   */
  getAllResponseHeaders() {
    return this._response.headers.getAll();
  }

  _getResponseText() {
    // Only supports responseType === '' or responseType === 'text'
    if (this._readyState !== MockXhr.LOADING && this._readyState !== MockXhr.DONE) {
      return '';
    }

    // Return the text response
    return this._response.body ? this._response.body : '';
  }

  _newEvent(name, transmitted, length) {
    return new Event(name, transmitted, length);
  }

  _fireEvent(name, transmitted, length) {
    this.dispatchEvent(this._newEvent(name, transmitted, length));
  }

  _fireUploadEvent(name, transmitted, length) {
    this._upload.dispatchEvent(this._newEvent(name, transmitted, length));
  }

  _fireReadyStateChange() {
    const event = new Event('readystatechange');
    if (this.onreadystatechange) {
      this.onreadystatechange(event);
    }
    this.dispatchEvent(event);
  }

  ///////////////////////////////////
  // Request and response handling //
  ///////////////////////////////////

  /**
   * Note: the "process request body" task is in the MockXhr response methods
   * Process request end-of-body task. When the whole request is sent.
   * https://xhr.spec.whatwg.org/#the-send()-method
   */
  _requestEndOfBody() {
    this._uploadCompleteFlag = true;

    if (this._uploadListenerFlag) {
      // If no listeners were registered before send(), these steps do not run.
      const length = this._getRequestBodySize();
      const transmitted = length;
      this._fireUploadEvent('progress', transmitted, length);
      this._fireUploadEvent('load', transmitted, length);
      this._fireUploadEvent('loadend', transmitted, length);
    }
  }

  /**
   * Process response task. When the response headers are received.
   * https://xhr.spec.whatwg.org/#the-send()-method
   *
   * @param {*} response response
   */
  _processResponse(response) {
    this._response = response;
    this._handleResponseErrors();
    if (this._isNetworkErrorResponse()) {
      return;
    }
    this._readyState = MockXhr.HEADERS_RECEIVED;
    this._fireReadyStateChange();
    if (this._readyState !== MockXhr.HEADERS_RECEIVED) {
      return;
    }
    if (this._response.body === null) {
      this._handleResponseEndOfBody();
    }
    // Further steps are triggered by the MockXhr response methods
  }

  /**
   * Handle response end-of-body for response.
   * https://xhr.spec.whatwg.org/#handle-response-end-of-body
   */
  _handleResponseEndOfBody() {
    this._handleResponseErrors();
    if (this._isNetworkErrorResponse()) {
      return;
    }
    const length = this._response.body ? this._response.body.length : 0;
    this._fireEvent('progress', length, length);
    this._readyState = MockXhr.DONE;
    this._sendFlag = false;
    this._fireReadyStateChange();
    this._fireEvent('load', length, length);
    this._fireEvent('loadend', length, length);
  }

  /**
   * Handle errors for response.
   * https://xhr.spec.whatwg.org/#handle-errors
   */
  _handleResponseErrors() {
    if (!this._sendFlag) {
      return;
    }
    if (this._timedOutFlag) {
      // Timeout
      this._requestErrorSteps('timeout');
    } else if (this._isNetworkErrorResponse()) {
      // Network error
      this._requestErrorSteps('error');
    }
  }

  /**
   * The request error steps for event 'event'.
   * https://xhr.spec.whatwg.org/#request-error-steps
   *
   * @param {string} event event name
   */
  _requestErrorSteps(event) {
    this._readyState = MockXhr.DONE;
    this._sendFlag = false;
    this._response = this._networkErrorResponse();
    this._fireReadyStateChange();
    if (!this._uploadCompleteFlag) {
      this._uploadCompleteFlag = true;

      if (this._uploadListenerFlag) {
        // If no listeners were registered before send(), no upload events should be fired.
        this._fireUploadEvent(event, 0, 0);
        this._fireUploadEvent('loadend', 0, 0);
      }
    }
    this._fireEvent(event, 0, 0);
    this._fireEvent('loadend', 0, 0);
  }

  ///////////////////////////
  // Mock response methods //
  ///////////////////////////

  /**
   * Fire a request upload progress event.
   *
   * @param {number} transmitted bytes transmitted
   */
  uploadProgress(transmitted) {
    if (!this._sendFlag || this._uploadCompleteFlag) {
      throw new Error('Mock usage error detected.');
    }
    if (this._uploadListenerFlag) {
      // If no listeners were registered before send(), no upload events should be fired.
      this._fireUploadEvent('progress', transmitted, this._getRequestBodySize());
    }
  }

  /**
   * Complete response method. Sets the response headers and body. Will set the
   * state to DONE.
   *
   * @param {number} status response http status (default 200)
   * @param {object} headers name-value headers (optional)
   * @param {*} body response body (default null)
   * @param {string} statusText response http status text (optional)
   */
  respond(status, headers, body, statusText) {
    this.setResponseHeaders(status, headers, statusText);
    this.setResponseBody(body);
  }

  /**
   * Set only the response headers. Will change the state to HEADERS_RECEIVED.
   *
   * @param {number} status response http status (default 200)
   * @param {object} headers name-value headers (optional)
   * @param {string} statusText response http status text (optional)
   */
  setResponseHeaders(status, headers, statusText) {
    if (this._readyState !== MockXhr.OPENED || !this._sendFlag) {
      throw new Error('Mock usage error detected.');
    }
    if (this.body) {
      this._requestEndOfBody();
    }
    status = typeof status === 'number' ? status : 200;
    const statusMessage = statusText !== undefined ? statusText : MockXhr.statusCodes[status];
    this._processResponse({
      status,
      statusMessage,
      headers: new HeadersContainer(headers),
    });
  }

  /**
   * Fire a response progress event. Will set the state to LOADING.
   *
   * @param {number} transmitted transmitted bytes
   * @param {number} length total bytes
   */
  downloadProgress(transmitted, length) {
    if (this._readyState !== MockXhr.HEADERS_RECEIVED
      && this._readyState !== MockXhr.LOADING) {
      throw new Error('Mock usage error detected.');
    }

    // Useless condition but follows the spec's wording
    if (this._readyState === MockXhr.HEADERS_RECEIVED) {
      this._readyState = MockXhr.LOADING;
    }

    // As stated in https://xhr.spec.whatwg.org/#the-send()-method
    // Web compatibility is the reason readystatechange fires more often than
    // state changes.
    this._fireReadyStateChange();
    this._fireEvent('progress', transmitted, length);
  }

  /**
   * Set the response body. Will set the state to DONE.
   *
   * @param {*} body response body (default null)
   */
  setResponseBody(body = null) {
    if (!this._sendFlag
      || (this._readyState !== MockXhr.OPENED
        && this._readyState !== MockXhr.HEADERS_RECEIVED
        && this._readyState !== MockXhr.LOADING)) {
      throw new Error('Mock usage error detected.');
    }
    if (this._readyState === MockXhr.OPENED) {
      // Default "200 - OK" response headers
      this.setResponseHeaders();
    }

    // As stated in https://xhr.spec.whatwg.org/#the-send()-method
    // Web compatibility is the reason readystatechange fires more often than
    // state changes.
    this._readyState = MockXhr.LOADING;
    this._fireReadyStateChange();

    this._response.body = body !== undefined ? body : null;
    this._handleResponseEndOfBody();
  }

  /**
   * Simulate a network error. Will set the state to DONE.
   */
  setNetworkError() {
    if (!this._sendFlag) {
      throw new Error('Mock usage error detected.');
    }
    this._processResponse(this._networkErrorResponse());
  }

  /**
   * Simulate a request timeout. Will set the state to DONE.
   */
  setRequestTimeout() {
    if (!this._sendFlag) {
      throw new Error('Mock usage error detected.');
    }
    this._terminateRequest();
    this._timedOutFlag = true;
    this._processResponse(this._networkErrorResponse());
  }

  _methodForbidden(method) {
    return /^(CONNECT|TRACE|TRACK)$/i.test(method);
  }

  /**
   * Create a new "local" MockXhr instance. This makes it easier to have
   * self-contained unit tests since they don't need to remove registered hook
   * functions.
   *
   * @return {MockXhr} Local MockXhr instance
   */
  static newMockXhr() {
    return class LocalMockXhr extends MockXhr {
      constructor() {
        super();

        // Call the local onCreate hook on the new mock instance
        if (typeof LocalMockXhr.onCreate === 'function') {
          LocalMockXhr.onCreate(this);
        }
      }

      // Override the parent method to enable the local MockXhr instance's
      // onSend() hook
      send(...args) {
        super.send(...args);

        // Execute in an empty callstack
        if (typeof LocalMockXhr.onSend === 'function') {
          // Save the callback in case it changes before it has a chance to run
          const { onSend } = LocalMockXhr;
          setTimeout(() => onSend.call(this, this), 0);
        }
      }
    };
  }
}

// Properties of the XMLHttpRequest class
Object.defineProperties(MockXhr.prototype, {
  readyState: {
    get() { return this._readyState; },
  },
  upload: {
    get() { return this._upload; },
  },
  status: {
    get() { return this._response.status; },
  },
  statusText: {
    get() { return this._response.statusMessage; },
  },
  responseType: {
    get() { return ''; },
    set() { throw new Error('Operation not supported.'); },
  },
  response: {
    get() { return this._getResponseText(); },
  },
  responseText: {
    get() { return this._getResponseText(); },
  },
});

/**
 * The client states
 * https://xhr.spec.whatwg.org/#states
 */
MockXhr.UNSENT = 0;
MockXhr.OPENED = 1;
MockXhr.HEADERS_RECEIVED = 2;
MockXhr.LOADING = 3;
MockXhr.DONE = 4;

/////////////
// Utility //
/////////////

// Disallowed request headers for setRequestHeader()
// See https://fetch.spec.whatwg.org/#forbidden-header-name
const forbiddenHeaders = [
  'Accept-Charset',
  'Accept-Encoding',
  'Access-Control-Request-Headers',
  'Access-Control-Request-Method',
  'Connection',
  'Content-Length',
  'Cookie',
  'Cookie2',
  'Date',
  'DNT',
  'Expect',
  'Host',
  'Keep-Alive',
  'Origin',
  'Referer',
  'TE',
  'Trailer',
  'Transfer-Encoding',
  'Upgrade',
  'Via',
];
const forbiddenHeaderRegEx = new RegExp(`^(${forbiddenHeaders.join('|')}|Proxy-.*|Sec-.*)$`, 'i');

/**
 * @param {string} name header name
 * @return {boolean} whether the request header name is forbidden
 */
function isForbiddenRequestHeader(name) {
  return forbiddenHeaderRegEx.test(name);
}

// Normalize method names as described in open()
// See https://fetch.spec.whatwg.org/#concept-method-normalize
const upperCaseMethods = [
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
];
const upperCaseMethodsRegEx = new RegExp(`^(${upperCaseMethods.join('|')})$`, 'i');

/**
 * @param {string} method method name
 * @return {string} normalized method name
 */
function normalizeMethodName(method) {
  if (upperCaseMethodsRegEx.test(method)) {
    method = method.toUpperCase();
  }
  return method;
}

MockXhr.statusCodes = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  300: 'Multiple Choice',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Request Entity Too Large',
  414: 'Request-URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Requested Range Not Satisfiable',
  417: 'Expectation Failed',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

module.exports = MockXhr;
