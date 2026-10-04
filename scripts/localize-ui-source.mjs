/** Migrate presentation strings only. Protocol values, user text and prompts stay unchanged. */
import ts from '../apps/geod-agent-desktop/node_modules/typescript/lib/typescript.js';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('apps/geod-agent-desktop/src');
const files=fs.readdirSync(root).filter(file=>file.endsWith('.tsx')&&!['language-dialog.tsx','ui-select.tsx'].includes(file));
const chinese=text=>/[\u3400-\u9fff]/u.test(text);
const attributes=new Set(['aria-label','aria-description','title','placeholder','alt','label','hint','description','content','emptyLabel','loadingLabel']);
const stats=[];
for(const name of files){
  const file=path.join(root,name),text=fs.readFileSync(file,'utf8'),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  if(text.includes('// i18n: presentation strings migrated'))continue;
  const edits=[],imports=new Set();
  const edit=(start,end,value)=>{if(edits.some(edit=>start<edit.end&&end>edit.start))return;edits.push({start,end,value});};
  function translation(node){
    if(ts.isStringLiteralLike(node)&&chinese(node.text)){imports.add('t');return`t(${JSON.stringify(node.text)})`;}
    if(ts.isTemplateExpression(node)){
      const key=node.head.text+node.templateSpans.map((span,i)=>`{${i}}${span.literal.text}`).join('');
      if(chinese(key)){imports.add('t');return`t(${JSON.stringify(key)}, {${node.templateSpans.map((span,i)=>`${JSON.stringify(String(i))}: ${span.expression.getText(source)}`).join(', ')}})`;}
    }
    return null;
  }
  function expression(node){
    const translated=translation(node);
    if(translated){edit(node.getStart(source),node.end,translated);return;}
    if(ts.isConditionalExpression(node)){expression(node.whenTrue);expression(node.whenFalse);}
    else if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)){expression(node.left);expression(node.right);}
    else if(ts.isParenthesizedExpression(node))expression(node.expression);
    else if(ts.isObjectLiteralExpression(node))for(const property of node.properties){if(ts.isPropertyAssignment(property)&&['label','hint','description','placeholder'].includes(property.name.getText(source).replaceAll('"','').replaceAll("'",'')))expression(property.initializer);}
    else if(ts.isArrayLiteralExpression(node))for(const item of node.elements)expression(item);
    else if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='map')for(const argument of node.arguments)if(ts.isArrowFunction(argument)&&ts.isParenthesizedExpression(argument.body)&&ts.isObjectLiteralExpression(argument.body.expression))expression(argument.body.expression);
  }
  function visit(node){
    if(ts.isJsxText(node)&&chinese(node.text)){
      const lines=node.text.replaceAll('\t',' ').split(/\r?\n/);let value='';
      lines.forEach((line,index)=>{let part=line;if(index>0)part=part.replace(/^ +/,'');if(index<lines.length-1)part=part.replace(/ +$/,'');if(part)value+=part+(index<lines.length-1?' ':'');});
      imports.add('t');edit(node.getStart(source),node.end,`{t(${JSON.stringify(value)})}`);
    }
    if(ts.isJsxAttribute(node)&&attributes.has(node.name.getText(source))&&node.initializer){
      if(ts.isStringLiteral(node.initializer)){const value=translation(node.initializer);if(value)edit(node.initializer.getStart(source),node.initializer.end,`{${value}}`);}
      else if(ts.isJsxExpression(node.initializer)&&node.initializer.expression)expression(node.initializer.expression);
    }
    if(ts.isJsxExpression(node)&&!ts.isJsxAttribute(node.parent)&&node.expression){
      expression(node.expression);
      const value=node.expression.getText(source);
      if(/^(?:error|notice|activity|liveActivity|label|hint|message\.details|status\.error|status\.message|probe\.message|option\.label|o\.label|item\.label|[\w.]*Labels\[.+\]|labels\[.+\])$/.test(value)&&!edits.some(edit=>edit.start>=node.expression.getStart(source)&&edit.end<=node.expression.end)){
        imports.add('localize');edit(node.expression.getStart(source),node.expression.end,`localize(${value})`);
      }
    }
    if(ts.isStringLiteral(node)&&node.text==='zh-CN'&&ts.isCallExpression(node.parent)&&ts.isPropertyAccessExpression(node.parent.expression)&&/^toLocale/.test(node.parent.expression.name.text)){
      imports.add('getLocale');edit(node.getStart(source),node.end,'getLocale()');
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
  if(!edits.length)continue;
  let next=text;
  for(const {start,end,value}of edits.sort((a,b)=>b.start-a.start))next=next.slice(0,start)+value+next.slice(end);
  const existing=next.match(/import \{([^}]+)\} from ["']\.\/i18n["'];?/);
  if(existing){const names=new Set(existing[1].split(',').map(item=>item.trim()));for(const name of imports)names.add(name);next=next.replace(existing[0],`import { ${[...names].join(', ')} } from "./i18n";`);}
  else next=`import { ${[...imports].join(', ')} } from "./i18n";\n// i18n: presentation strings migrated\n`+next;
  fs.writeFileSync(file,next);stats.push({file:name,presentationEdits:edits.length});
}
console.log(JSON.stringify(stats));
