export class CodexAuthFileError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.name = "CodexAuthFileError";
    this.status = status;
    this.code = code;
  }
}
