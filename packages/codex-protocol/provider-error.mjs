export class ProviderError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
export const providerFail = (code, status) => { throw new ProviderError(code, status); };
