// Language names are small. The full engine used by the formula editor is
// loaded when it requests highlighted tokens, rather than on every board.
export { bundledLanguagesInfo } from 'shiki/langs';

export const codeToTokensBase: typeof import('shiki').codeToTokensBase = async (...args) => {
  const shiki = await import('shiki/bundle/full');
  return shiki.codeToTokensBase(...args);
};
