// Authored binary Office fixtures. Only this test generator writes documents.
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.poi.hssf.usermodel.*;
import org.apache.poi.hwpf.HWPFDocument;
import org.apache.poi.hslf.usermodel.*;
import org.apache.poi.hslf.record.*;
import org.apache.poi.poifs.crypt.cryptoapi.CryptoAPIEncryptionInfoBuilder;
import org.apache.poi.hssf.record.crypto.Biff8EncryptionKey;
import org.apache.poi.common.usermodel.HyperlinkType;

public final class LegacyOfficeFixtures {
    private static void word(Path root,String name,String text)throws Exception {
        try(var input=Files.newInputStream(root.resolve("apache-empty.doc"));var document=new HWPFDocument(input)) {
            document.getRange().insertBefore(text+"\r");
            try(var output=Files.newOutputStream(root.resolve(name))){document.write(output);}
        }
    }
    private static void excel(Path root,String marker,boolean encrypted)throws Exception {
        if(encrypted)Biff8EncryptionKey.setCurrentUserPassword("owned-qa-password");
        try(var workbook=new HSSFWorkbook()) {
            var coordinates=workbook.createSheet("Coordinates");
            String[][] values={{"City","北京 / Beijing"},{"Zoom","12"},{"Marker",marker},{"West","116.10"},{"South","39.10"},{"East","116.20"},{"North","39.20"}};
            for(int i=0;i<values.length;i++){var row=coordinates.createRow(i);row.createCell(0).setCellValue(values[i][0]);row.createCell(1).setCellValue(values[i][1]);}
            var formula=coordinates.createRow(8).createCell(1);formula.setCellFormula("8+9");formula.setCellValue(3.0);
            var link=workbook.getCreationHelper().createHyperlink(HyperlinkType.URL);link.setAddress("http://127.0.0.1:43181/should-not-be-fetched");coordinates.getRow(0).getCell(1).setHyperlink(link);
            workbook.createSheet("第二工作表").createRow(0).createCell(0).setCellValue("SECOND_SHEET_AFTER_FIRST");
            try(var output=Files.newOutputStream(root.resolve(encrypted?"encrypted.xls":"beijing-table.xls"))){workbook.write(output);}
        } finally{Biff8EncryptionKey.setCurrentUserPassword(null);}
    }
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args[0]);String en=args[1],zh=args[2],xls=args[3],ppt=args[4];
        word(root,"beijing-brief.doc","Binary Word geographic brief\rCity: Beijing\rZoom: Z12\rWest 116.10, South 39.10, East 116.20, North 39.20\rMarker: "+en);
        word(root,"北京旧版说明.doc","旧版 Word 范围说明\r城市：北京市\r缩放级别：Z12\r范围：116.10, 39.10, 116.20, 39.20\r标记："+zh);
        excel(root,xls,false);excel(root,xls,true);
        try(var show=new HSLFSlideShow()) {
            var first=show.createSlide();var box=new HSLFTextBox();box.setText("ORIGINAL_FIRST_SLIDE\nBeijing Z12\n"+ppt);first.addShape(box);
            var second=show.createSlide();var box2=new HSLFTextBox();box2.setText("REORDERED_FIRST_SLIDE\n北京\n116.10,39.10,116.20,39.20");second.addShape(box2);
            show.reorderSlide(2,1);
            try(var output=Files.newOutputStream(root.resolve("beijing-slides.ppt"))){show.write(output);}
        }
        Files.writeString(root.resolve("damaged.doc"),"this is not an OLE Word file");
        Files.writeString(root.resolve("damaged.xls"),"this is not a workbook");
        Files.writeString(root.resolve("damaged.ppt"),"this is not a presentation");
        Files.copy(root.resolve("beijing-table.xls"),root.resolve("renamed-workbook.doc"));
    }
}
