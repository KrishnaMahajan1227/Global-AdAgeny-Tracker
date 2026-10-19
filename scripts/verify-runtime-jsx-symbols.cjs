// JSX runtime safety check that works even where package registry dependencies
// are not installed. A missing imported icon used as <Icon/> caused a crash.
const fs=require('fs'); const path=require('path'); const ts=require('typescript');
const root=path.resolve(__dirname,'../src');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)): /\.tsx$/.test(entry.name)?[path.join(dir,entry.name)]:[])}
let tested=0;const issues=[];
for(const filepath of files(root)){
 const source=ts.createSourceFile(filepath,fs.readFileSync(filepath,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 if(source.parseDiagnostics.length) for(const diag of source.parseDiagnostics)issues.push(`${filepath}: parse error ${ts.flattenDiagnosticMessageText(diag.messageText,' ')}`);
 const declared=new Set(['React','Fragment']);const jsx=new Set();
 function addBinding(name){if(ts.isIdentifier(name))declared.add(name.text);else if(ts.isObjectBindingPattern(name)||ts.isArrayBindingPattern(name)) name.elements.forEach(x=>{if(ts.isBindingElement(x))addBinding(x.name)});}
 function walk(node){
  if(ts.isImportClause(node)){if(node.name)declared.add(node.name.text); const binds=node.namedBindings;if(binds){if(ts.isNamespaceImport(binds))declared.add(binds.name.text);else binds.elements.forEach(element=>declared.add(element.name.text))}}
  if(ts.isVariableDeclaration(node)||ts.isParameter(node))addBinding(node.name);
  if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isEnumDeclaration(node))&&node.name)declared.add(node.name.text);
  if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){
   if(ts.isIdentifier(node.tagName)&&/^[A-Z]/.test(node.tagName.text))jsx.add(node.tagName.text);
  }
  ts.forEachChild(node,walk);
 }
 walk(source);
 for(const component of jsx)if(!declared.has(component))issues.push(`${path.relative(root,filepath)}: JSX <${component}/> is not imported or declared`);
 tested++;
}
if(issues.length){console.error(`FAIL: ${issues.length} JSX symbol/parse issues across ${tested} TSX files\n`+issues.join('\n'));process.exit(1)}
console.log(`PASS: ${tested} TSX files parse; all JSX component/ icon names resolve to local declarations/imports.`);
