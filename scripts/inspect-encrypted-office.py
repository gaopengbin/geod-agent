"""Acceptance-only exception inspection, with password redaction before output."""
from pathlib import Path
import json,os,shutil,subprocess
repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/encrypted-documents'
runtime=repo/'apps/geod-agent-desktop/src-tauri/resources/legacy-office'
source=root/'fixture-generator/EncryptedOfficeProbe.java'
source.write_text('''import java.nio.file.*;import java.util.*;import com.fasterxml.jackson.databind.ObjectMapper;import org.apache.poi.hssf.record.crypto.Biff8EncryptionKey;import org.apache.poi.hslf.usermodel.HSLFSlideShow;
public class EncryptedOfficeProbe{public static void main(String[] args)throws Exception{var json=new ObjectMapper();var input=json.readTree(System.in);Biff8EncryptionKey.setCurrentUserPassword(input.get("password").isNull()?null:input.get("password").asText());try(var stream=Files.newInputStream(Path.of(args[0]));var show=new HSLFSlideShow(stream)){System.out.println(json.writeValueAsString(Map.of("slides",show.getSlides().size())));}catch(Exception e){var failures=new ArrayList<Map<String,String>>();for(Throwable p=e;p!=null;p=p.getCause())failures.add(Map.of("class",p.getClass().getName(),"message",String.valueOf(p.getMessage())));System.out.println(json.writeValueAsString(failures));}}}
''',encoding='utf-8')
subprocess.run([shutil.which('javac'),'--release','17','-encoding','UTF-8','-cp',str(runtime/'tika-app-3.3.2.jar'),'-d',str(source.parent),str(source)],check=True,creationflags=subprocess.CREATE_NO_WINDOW)
passwords=json.loads((root/'private-passwords.json').read_text(encoding='utf-8'))
result=[]
for label,password in [('missing',None),('incorrect','INCORRECT_QA_VALUE'),('correct',passwords['binary.ppt'])]:
    value=subprocess.run([str(runtime/'java/bin/java.exe'),'-Dfile.encoding=UTF-8','-cp',str(source.parent)+os.pathsep+str(runtime/'tika-app-3.3.2.jar'),'EncryptedOfficeProbe',str(root/'workspace/binary.ppt')],input=json.dumps({'password':password}).encode('utf-8'),capture_output=True,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
    text=value.stdout.decode('utf-8')
    assert all(secret not in text for secret in passwords.values())
    result.append(dict(case=label,diagnostic=json.loads(text)))
(root/'ppt-diagnostic.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
