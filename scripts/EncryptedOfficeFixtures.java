// Independently authored encrypted Office files for local acceptance only.
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.poi.hssf.usermodel.*;
import org.apache.poi.hssf.record.crypto.Biff8EncryptionKey;
import org.apache.poi.hwpf.HWPFDocument;
import org.apache.poi.hslf.usermodel.*;
import org.apache.poi.poifs.filesystem.POIFSFileSystem;
import org.apache.poi.poifs.crypt.*;

public final class EncryptedOfficeFixtures {
  public static void main(String[] args)throws Exception {
    var request=new ObjectMapper().readTree(System.in);
    Path root=Path.of(args[0]);
    if(request.has("variants")) {
      for(var variant:request.get("variants"))try(var fs=new POIFSFileSystem()) {
        var info=new EncryptionInfo(EncryptionMode.agile,CipherAlgorithm.valueOf(variant.get("cipher").asText()),HashAlgorithm.valueOf(variant.get("hash").asText()),-1,-1,ChainingMode.valueOf(variant.get("chaining").asText()));
        var encryptor=info.getEncryptor();encryptor.confirmPassword(variant.get("password").asText());
        try(var output=encryptor.getDataStream(fs)){Files.copy(root.resolve("plain.docx"),output);}
        try(var output=Files.newOutputStream(root.resolve(variant.get("name").asText()))){fs.writeFilesystem(output);}
      }
      return;
    }
    for(String extension:List.of("docx","xlsx","pptx"))for(String mode:List.of("agile","standard")) {
      try(var fs=new POIFSFileSystem()) {
        var info=new EncryptionInfo(EncryptionMode.valueOf(mode));
        var encryptor=info.getEncryptor();
        encryptor.confirmPassword(request.get("passwords").get(mode+"."+extension).asText());
        try(var output=encryptor.getDataStream(fs)){Files.copy(root.resolve("plain."+extension),output);}
        try(var output=Files.newOutputStream(root.resolve(mode+"."+extension))){fs.writeFilesystem(output);}
      }
    }
    try(var input=Files.newInputStream(Path.of(args[1]));var doc=new HWPFDocument(input)) {
      doc.getRange().insertBefore("GeoD encrypted Word reference\rCity: Beijing\r"+request.get("markers").get("doc").asText()+"\r");
      Biff8EncryptionKey.setCurrentUserPassword(request.get("passwords").get("binary.doc").asText());
      try(var output=Files.newOutputStream(root.resolve("binary.doc"))){doc.write(output);}
    }finally{Biff8EncryptionKey.setCurrentUserPassword(null);}
    try(var book=new HSSFWorkbook()) {
      var sheet=book.createSheet("Beijing");sheet.createRow(0).createCell(0).setCellValue(request.get("markers").get("xls").asText());
      var formula=sheet.createRow(1).createCell(0);formula.setCellFormula("8+9");formula.setCellValue(3.0);
      Biff8EncryptionKey.setCurrentUserPassword(request.get("passwords").get("binary.xls").asText());
      try(var output=Files.newOutputStream(root.resolve("binary.xls"))){book.write(output);}
    }finally{Biff8EncryptionKey.setCurrentUserPassword(null);}
    try(var show=new HSLFSlideShow()) {
      var slide=show.createSlide();var box=new HSLFTextBox();box.setText(request.get("markers").get("ppt").asText());slide.addShape(box);
      Biff8EncryptionKey.setCurrentUserPassword(request.get("passwords").get("binary.ppt").asText());
      try(var output=Files.newOutputStream(root.resolve("binary.ppt"))){show.write(output);}
    }finally{Biff8EncryptionKey.setCurrentUserPassword(null);}
    System.out.println("{\"prepared\":true,\"encryptedOfficeFiles\":9}");
  }
}
