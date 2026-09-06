/**
 * 统一的业务错误类型：service 层抛出，middleware/error-handler 统一转为 HTTP 响应。
 */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR', details?: Record<string, unknown>) {
    super(400, code, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未登录或会话已过期', code = 'UNAUTHORIZED', details?: Record<string, unknown>) {
    super(401, code, message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, code = 'FORBIDDEN', details?: Record<string, unknown>) {
    super(403, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(404, 'NOT_FOUND', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', details?: Record<string, unknown>) {
    super(409, code, message, details);
  }
}

export class LockedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(423, 'ACCOUNT_LOCKED', message, details);
  }
}

export class BillingError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(503, 'BILLING_TX_FAILED', message, details);
  }
}
