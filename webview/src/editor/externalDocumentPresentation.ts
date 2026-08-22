import { Annotation, type Transaction } from '@codemirror/state';

const externalDocumentPresentation = Annotation.define<true>();

export function markExternalDocumentPresentation(): Annotation<true> {
  return externalDocumentPresentation.of(true);
}

export function isExternalDocumentPresentation(transaction: Transaction): boolean {
  return transaction.annotation(externalDocumentPresentation) === true;
}
