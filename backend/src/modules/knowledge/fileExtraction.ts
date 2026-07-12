import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { ApiError } from "../../lib/errors";

// One extractor per supported file type — the seam is deliberately narrow
// (Buffer in, plain text out) so the actual knowledge_sources.type values
// (pdf/word/excel) map 1:1 to a function here. Anything else is rejected
// rather than silently accepted as opaque bytes.
export async function extractText(buffer: Buffer, sourceType: string): Promise<string> {
  switch (sourceType) {
    case "pdf": {
      const result = await pdfParse(buffer);
      return result.text.trim();
    }
    case "word": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }
    case "excel": {
      const workbook = new ExcelJS.Workbook();
      // exceljs's bundled type defs pin a slightly different (structurally
      // incompatible) Buffer shape than our @types/node version — same
      // runtime type, harmless nominal mismatch.
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      const lines: string[] = [];
      workbook.eachSheet((sheet) => {
        sheet.eachRow((row) => {
          const cells = (row.values as unknown[]).slice(1).map((c) => (c == null ? "" : String(c)));
          const line = cells.join(" | ").trim();
          if (line) lines.push(line);
        });
      });
      return lines.join("\n");
    }
    default:
      throw ApiError.badRequest(`استخراج النص غير مدعوم لنوع الملف "${sourceType}" — الأنواع المدعومة: pdf, word, excel`);
  }
}

export const MIME_BY_TYPE: Record<string, string[]> = {
  pdf: ["application/pdf"],
  word: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  excel: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
  ],
};

export function validateMimeMatchesType(sourceType: string, mimeType: string) {
  const allowed = MIME_BY_TYPE[sourceType];
  if (allowed && !allowed.includes(mimeType)) {
    throw ApiError.badRequest(
      `نوع الملف المرفوع (${mimeType}) لا يطابق النوع المُعلَن "${sourceType}"`
    );
  }
}
