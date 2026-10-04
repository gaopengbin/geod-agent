export interface ElicitationField {
  title?: string; description?: string; type?: string; default?: unknown;
  enum?: string[]; enumNames?: string[]; oneOf?: { const: string; title?: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title?: string }[] };
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number;
}
export interface ElicitationSchema { properties?: Record<string, ElicitationField>; required?: string[] }
export function elicitationBrowserUrl(value:unknown):URL|null{
  if(typeof value!=="string"||value.length>8192)return null;
  try{const url=new URL(value),local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);return url.hostname&&(url.protocol==="https:"||url.protocol==="http:"&&local)&&!url.username&&!url.password?url:null;}catch{return null;}
}
export function fieldOptions(field: ElicitationField): { value: string; label: string }[] {
  return field.oneOf?.map(item => ({ value: item.const, label: item.title ?? item.const }))
    ?? field.items?.anyOf?.map(item => ({ value: item.const, label: item.title ?? item.const }))
    ?? (field.enum ?? field.items?.enum ?? []).map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
}
/** Keep schema types across the MCP form boundary; invalid values never leave the card. */
export function elicitationContent(schema: ElicitationSchema, values: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    let value = values[name] ?? field.default;
    if (value === undefined || value === "") {
      if (schema.required?.includes(name)) throw new Error(`请填写${field.title ?? name}`);
      continue;
    }
    const invalid = () => { throw new Error(`${field.title ?? name}的值不符合要求`); };
    if (field.type === "boolean") { if (typeof value !== "boolean") invalid(); }
    else if (field.type === "number" || field.type === "integer") {
      value = Number(value);
      if (!Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value) || field.minimum !== undefined && (value as number) < field.minimum || field.maximum !== undefined && (value as number) > field.maximum) invalid();
    } else if (field.type === "array") {
      if (!Array.isArray(value) || value.some(item => typeof item !== "string") || field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) invalid();
    } else if (field.type === "string") {
      if (typeof value !== "string" || field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength) invalid();
    } else throw new Error(`暂不支持字段类型：${field.type ?? name}`);
    const options = fieldOptions(field).map(item => item.value);
    if (options.length && (Array.isArray(value) ? value.some(item => !options.includes(item)) : !options.includes(value as string))) invalid();
    content[name] = value;
  }
  return content;
}
