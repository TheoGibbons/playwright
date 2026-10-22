/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export const badRequest = (message, details) => new HttpError(400, 'invalid_request', message, details);

export const jobTimeout = (ms) => new HttpError(504, 'job_timeout', `Render did not finish within ${ms}ms`);

export const clientGone = () => new HttpError(499, 'client_closed_request', 'Client disconnected');
