// Read-only binary Office extraction using Apache POI bundled by maintained Tika.
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.poi.hssf.usermodel.HSSFWorkbook;
import org.apache.poi.hssf.record.crypto.Biff8EncryptionKey;
import org.apache.poi.hslf.usermodel.*;
import org.apache.poi.hwpf.extractor.WordExtractor;
import org.apache.poi.poifs.filesystem.POIFSFileSystem;
import org.apache.poi.ss.usermodel.*;

public final class GeodOfficeReader {
    private static final int MAX_CHARS = 2_000_000;
    private static final ObjectMapper JSON = new ObjectMapper();
    private final StringBuilder text = new StringBuilder();
    private boolean truncated;
    private boolean formulas;

    private void add(String label, String value) {
        if (value == null || value.isEmpty() || truncated) return;
        var cleaned=new StringBuilder();
        for(char character:value.replace("\r\n","\n").replace('\r','\n').replace('\u0007','\t').replace('\u000b','\n').toCharArray()) {
            if(character=='\n'||character=='\t'||character>=32) cleaned.append(character);
        }
        String content = "\n[" + label + "]\n" + cleaned;
        int remaining = MAX_CHARS - text.length();
        if (content.length() > remaining) {
            int end=remaining;if(end>0&&Character.isHighSurrogate(content.charAt(end-1)))end--;
            content = content.substring(0, end); truncated = true;
        }
        text.append(content);
    }
    private Map<String,Object> result(String kind, int units, String label) {
        var value = new LinkedHashMap<String,Object>();
        value.put("ok",true); value.put("text",text.toString()); value.put("truncated",truncated);
        value.put("kind",kind); value.put("units",units); value.put("unitLabel",label);
        value.put("warnings",formulas?List.of("FORMULAS_NOT_RECALCULATED"):List.of());
        return value;
    }
    private Map<String,Object> read(Path file, String extension) throws Exception {
        if (Files.size(file)>32L*1024*1024) throw new IOException("ATTACHMENT_CONTENT_LIMIT");
        try (var input=Files.newInputStream(file); var filesystem=new POIFSFileSystem(input)) {
            var root=filesystem.getRoot();
            if (root.hasEntry("EncryptedPackage") || root.hasEntry("EncryptionInfo")) throw new IOException("ATTACHMENT_PASSWORD_REQUIRED");
            boolean matches = switch(extension) {
                case "doc" -> root.hasEntry("WordDocument");
                case "xls" -> root.hasEntry("Workbook") || root.hasEntry("Book");
                case "ppt" -> root.hasEntry("PowerPoint Document");
                default -> false;
            };
            if (!matches) throw new IOException("ATTACHMENT_DOCUMENT_INVALID");
            if (extension.equals("doc")) {
                try(var extractor=new WordExtractor(filesystem)) { add("正文",extractor.getText()); }
                return result("word",1,"parts");
            }
            if (extension.equals("xls")) {
                try(var workbook=new HSSFWorkbook(filesystem)) {
                    var formatter=new DataFormatter(Locale.ROOT);
                    formatter.setUseCachedValuesForFormulaCells(true);
                    if(workbook.getNumberOfSheets()>1000) throw new IOException("ATTACHMENT_CONTENT_LIMIT");
                    var names=new ArrayList<String>();
                    for(var sheet:workbook) {
                        names.add(sheet.getSheetName()); add(sheet.getSheetName()," ");
                        for(var row:sheet) {
                            var cells=new ArrayList<String>();
                            for(var cell:row) {
                                String value=formatter.formatCellValue(cell);
                                if(cell.getCellType()==CellType.FORMULA) {
                                    formulas=true; value+=(value.isEmpty()?"":" ")+"[formula: "+cell.getCellFormula()+"]";
                                }
                                if(!value.isEmpty()) cells.add(cell.getAddress()+": "+value);
                            }
                            if(!cells.isEmpty()) add("Row "+(row.getRowNum()+1),String.join(" | ",cells));
                            if(truncated) break;
                        }
                        if(truncated) break;
                    }
                    var value=result("spreadsheet",workbook.getNumberOfSheets(),"sheets");
                    value.put("sheets",names); return value;
                }
            }
            // HSLF's slide list follows presentation order, including reordered slides.
            try(var presentation=new HSLFSlideShow(filesystem)) {
                var slides=presentation.getSlides();
                if(slides.size()>1000) throw new IOException("ATTACHMENT_CONTENT_LIMIT");
                for(int index=0;index<slides.size()&&!truncated;index++) {
                    var slide=slides.get(index);
                    add("Slide "+(index+1),paragraphs(slide.getTextParagraphs()));
                    if(slide.getNotes()!=null) add("Notes "+(index+1),paragraphs(slide.getNotes().getTextParagraphs()));
                }
                return result("presentation",slides.size(),"slides");
            }
        }
    }
    private String paragraphs(List<List<HSLFTextParagraph>> groups) {
        var output=new StringBuilder();
        for(var group:groups) {
            output.append(HSLFTextParagraph.getText(group)).append('\n');
            if(output.length()>MAX_CHARS) break;
        }
        return output.toString();
    }
    private static String error(Throwable failure,boolean supplied) {
        for(Throwable current=failure;current!=null;current=current.getCause()) {
            String message=String.valueOf(current.getMessage());
            if(message.equals("ATTACHMENT_PASSWORD_REQUIRED")) return supplied?"ATTACHMENT_PASSWORD_UNSUPPORTED":"ATTACHMENT_PASSWORD_REQUIRED";
            if(message.equals("ATTACHMENT_PASSWORD_INPUT")) return "ATTACHMENT_PASSWORD_INPUT";
            if(current instanceof org.apache.poi.EncryptedDocumentException || current instanceof org.apache.poi.hslf.exceptions.EncryptedPowerPointFileException) return supplied?"ATTACHMENT_PASSWORD_INCORRECT":"ATTACHMENT_PASSWORD_REQUIRED";
            if(message.equals("ATTACHMENT_CONTENT_LIMIT") || current instanceof OutOfMemoryError) return "ATTACHMENT_CONTENT_LIMIT";
        }
        return "ATTACHMENT_DOCUMENT_INVALID";
    }
    public static void main(String[] args) throws Exception {
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out),true,StandardCharsets.UTF_8));
        if(args.length==1 && args[0].equals("--runtime-check")) {
            System.out.println(JSON.writeValueAsString(Map.of("ready",true,"parser","Apache POI / Tika 3.3.2","poiVersion",org.apache.poi.Version.getVersion()))); return;
        }
        String password=null;
        try {
            if((args.length!=2&&args.length!=3) || !List.of("doc","xls","ppt").contains(args[1])) throw new IOException("ATTACHMENT_DOCUMENT_INVALID");
            if(args.length==3) {
                if(!args[2].equals("--password-stdin")) throw new IOException("ATTACHMENT_DOCUMENT_INVALID");
                byte[] request=System.in.readNBytes(32769);
                if(request.length>32768) throw new IOException("ATTACHMENT_PASSWORD_INPUT");
                var value=JSON.readTree(request).get("password");
                if(value!=null&&!value.isNull()) {
                    if(!value.isTextual()) throw new IOException("ATTACHMENT_PASSWORD_INPUT");
                    password=value.asText();
                    if(password.getBytes(StandardCharsets.UTF_8).length>4096) throw new IOException("ATTACHMENT_PASSWORD_INPUT");
                }
            }
            Biff8EncryptionKey.setCurrentUserPassword(password);
            System.out.println(JSON.writeValueAsString(new GeodOfficeReader().read(Path.of(args[0]),args[1])));
        } catch(Exception|OutOfMemoryError failure) {
            System.out.println(JSON.writeValueAsString(Map.of("ok",false,"error",error(failure,password!=null)))); System.exit(1);
        } finally {Biff8EncryptionKey.setCurrentUserPassword(null);}
    }
}
