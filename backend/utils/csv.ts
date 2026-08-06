'use strict';

type CsvSplitOptions = {
  trimAndDropEmpty?: boolean;
};

type CsvParseOptions = {
  trimValues?: boolean;
};

function splitCsvLines(content: string, options: CsvSplitOptions = {}): string[] {
  const { trimAndDropEmpty = false } = options;
  const lines: string[] = [];
  let recordStart = 0;
  let inQuotes = false;

  // Keep records as slices of the source string. Building `current` one
  // character at a time creates hundreds of megabytes of temporary strings
  // for the bundled airport CSVs.

  function appendRecord(recordEnd: number): void {
    const record = content.slice(recordStart, recordEnd);
    if (trimAndDropEmpty ? record.trim().length > 0 : record.length > 0) {
      lines.push(record);
    }
  }

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (char === '"') {
      if (inQuotes && content[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      appendRecord(index);
      if (char === '\r' && content[index + 1] === '\n') {
        index += 1;
      }
      recordStart = index + 1;
    }
  }

  if (
    recordStart < content.length ||
    (content.length > 0 && content[content.length - 1] !== '\n' && content[content.length - 1] !== '\r')
  ) {
    appendRecord(content.length);
  }

  return lines;
}

function parseCsvLine(line: string, options: CsvParseOptions = {}): string[] {
  const { trimValues = false } = options;
  const values: string[] = [];
  let fieldStart = 0;
  let fieldParts: string[] | null = null;
  let inQuotes = false;

  // Unquoted fields take one slice. Only quoted/escaped fields need a small
  // parts array so quote removal retains the parser's existing behavior.

  function appendFieldPart(end: number): void {
    if (end <= fieldStart) return;
    if (!fieldParts) fieldParts = [];
    fieldParts.push(line.slice(fieldStart, end));
  }

  function finishField(end: number): void {
    let value: string;
    if (fieldParts) {
      appendFieldPart(end);
      value = fieldParts.join('');
    } else {
      value = line.slice(fieldStart, end);
    }
    values.push(trimValues ? value.trim() : value);
    fieldParts = null;
  }

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      appendFieldPart(index);
      if (inQuotes && line[index + 1] === '"') {
        if (!fieldParts) fieldParts = [];
        fieldParts.push('"');
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      fieldStart = index + 1;
    } else if (char === ',' && !inQuotes) {
      finishField(index);
      fieldStart = index + 1;
    }
  }

  finishField(line.length);
  return values;
}

function getCsvRowWidthError(headers: unknown[], values: unknown[], rowNumber: number): string | null {
  if (values.length === headers.length) return null;
  return `CSV row ${rowNumber} has ${values.length} columns; expected ${headers.length}`;
}

const csvApi = {
  getCsvRowWidthError,
  parseCsvLine,
  splitCsvLines,
};

module.exports = csvApi;

export {};
