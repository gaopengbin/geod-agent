/** Replace only known tile tokens. Ordinary query values and their encoding stay intact. */
export function normalizeTileTemplate(template: string): string {
  const tokens: Record<string, string> = {x:'x',y:'y',z:'z',s:'s',TileMatrix:'z',TileRow:'y',TileCol:'x'};
  let result=template.trim();
  for(const [name, canonical] of Object.entries(tokens)) {
    result=result.replaceAll(`{${name}}`,'{'+canonical+'}');
    const encoded=new RegExp(`%7[bB]${name}%7[dD]`,'g');
    result=result.replace(encoded,'{'+canonical+'}');
  }
  return result;
}
