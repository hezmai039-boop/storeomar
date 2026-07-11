export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static unauthorized(message = "لم يتم التحقق من الهوية") {
    return new ApiError(401, "UNAUTHENTICATED", message);
  }
  static storeAccessDenied() {
    return new ApiError(403, "STORE_ACCESS_DENIED", "لا تملك صلاحية الوصول لهذا المتجر");
  }
  static permissionDenied(permission: string) {
    return new ApiError(403, "PERMISSION_DENIED", `لا تملك صلاحية "${permission}"`, { permission });
  }
  static notFound(entity: string) {
    return new ApiError(404, "NOT_FOUND", `${entity} غير موجود`);
  }
  static badRequest(message: string, details: Record<string, unknown> = {}) {
    return new ApiError(400, "BAD_REQUEST", message, details);
  }
  static conflict(message: string) {
    return new ApiError(409, "CONFLICT", message);
  }
}
