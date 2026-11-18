// Friendly random device names ("용감한 수달") and the matching avatar glyph and colour.

const ADJECTIVES = [
  '용감한',
  '졸린',
  '신난',
  '조용한',
  '반짝이는',
  '느긋한',
  '재빠른',
  '수줍은',
  '든든한',
  '상냥한',
  '씩씩한',
  '포근한',
  '명랑한',
  '똑똑한',
  '부지런한',
  '엉뚱한',
  '다정한',
  '말랑한',
  '튼튼한',
  '깜찍한',
  '산뜻한',
  '행복한',
  '배고픈',
  '호기심 많은',
  '꼼꼼한',
  '대담한',
  '차분한',
  '날쌘',
  '귀여운',
  '멋진',
];

const ANIMALS: Array<[string, string]> = [
  ['수달', '🦦'],
  ['판다', '🐼'],
  ['여우', '🦊'],
  ['고양이', '🐱'],
  ['강아지', '🐶'],
  ['토끼', '🐰'],
  ['다람쥐', '🐿️'],
  ['펭귄', '🐧'],
  ['부엉이', '🦉'],
  ['코알라', '🐨'],
  ['호랑이', '🐯'],
  ['사자', '🦁'],
  ['곰', '🐻'],
  ['너구리', '🦝'],
  ['돌고래', '🐬'],
  ['고래', '🐳'],
  ['문어', '🐙'],
  ['거북이', '🐢'],
  ['햄스터', '🐹'],
  ['병아리', '🐥'],
  ['오리', '🦆'],
  ['고슴도치', '🦔'],
  ['나무늘보', '🦥'],
  ['기린', '🦒'],
  ['코끼리', '🐘'],
  ['알파카', '🦙'],
  ['비버', '🦫'],
  ['캥거루', '🦘'],
  ['물개', '🦭'],
  ['개구리', '🐸'],
];

export function randomName(): string {
  const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)[0]}`;
}

/** The animal emoji if the name ends with a known animal, otherwise its first character. */
export function avatarGlyph(name: string): string {
  const trimmed = name.trim();
  for (const [animal, emoji] of ANIMALS) if (trimmed.endsWith(animal)) return emoji;
  return [...trimmed][0]?.toUpperCase() ?? '?';
}

const HUES = [228, 262, 292, 335, 12, 32, 152, 172, 196, 210];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A stable hue for a name, used for avatar backgrounds (lightness comes from the theme). */
export function avatarHue(name: string): number {
  return HUES[hash(name) % HUES.length]!;
}
