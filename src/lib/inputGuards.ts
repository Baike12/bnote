/** Spread onto text inputs to stop macOS inline predictive text /
 *  autocorrect from popping a suggestion bar while typing. */
export const inputGuards = {
  autoCorrect: "off",
  autoCapitalize: "off",
  autoComplete: "off",
  spellCheck: false,
} as const;
