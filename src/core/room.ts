export function generateRoomId(playerNames: string[]): string {
  const sorted = [...playerNames].sort();
  const combined = sorted.join('|');
  let hash = 5381;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** Keep automatic match discovery by default; an invite code creates a
 * separate room for this exact match roster. */
export function withPrivateRoomCode(matchRoomId: string, code: string): string {
  const normalized = code.trim().replace(/\s+/g, '').toLowerCase();
  if (!normalized) return matchRoomId;
  if (!/^[a-z0-9_-]{12,48}$/.test(normalized)) {
    throw new Error('Private room codes must be 12–48 letters or numbers');
  }
  return 'p' + normalized + '.' + matchRoomId;
}

export function isPrivateMatchRoom(roomId: string): boolean {
  return /^p[a-z0-9_-]{12,48}\./i.test(roomId);
}
