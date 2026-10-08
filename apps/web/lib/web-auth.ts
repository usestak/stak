/** The web calls the P3 service as the signed-in session user (identity never from input). */
export const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });
