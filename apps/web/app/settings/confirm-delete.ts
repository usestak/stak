export const DELETE_CONFIRMATION_PHRASE = 'DELETE CLOUD MEMORY';

/** Typed-confirmation gate (contract §9/§22) for the one destructive action Settings exposes. */
export const isValidDeleteConfirmation = (input: string | undefined): boolean =>
  input === DELETE_CONFIRMATION_PHRASE;
