export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}
export const validationError = (fields: Record<string, string>) =>
  new ApiError(422, "validation_failed", "One or more fields are invalid.", fields);
