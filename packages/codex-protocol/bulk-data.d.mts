export const BULK_DATA_POLICY:string;
export function hasBulkGeometry(value:unknown):boolean;
export function compactGeometryToolOutput<T>(value:T):T;
export function compactGeometryRequest<T>(value:T):T;
export function compactGeometryHistory<T>(value:T):T;
export function persistEmbeddedGeometryRequest<T>(request:T,save:(data:{connectorId:string;toolName:string;arguments:Record<string,unknown>;callId:string;result:unknown})=>Promise<unknown>):Promise<T>;
export function persistEmbeddedGeometryHistory<T>(messages:T,save:(data:{connectorId:string;toolName:string;arguments:Record<string,unknown>;callId:string;result:unknown})=>Promise<unknown>):Promise<T>;
