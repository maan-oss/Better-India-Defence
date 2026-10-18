/**
 * Password policy for passwords an administrator chooses or sets (the demonstration accounts are seeded by the server
 * and are not subject to it). It follows NIST SP 800-63B: length, no composition rules, a denylist, and no password
 * built from the account name. The denylist is a sample of the most common passwords and words, not a breach corpus;
 * an operating organisation should add its own list through the policy when it has one.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const DENYLIST = new Set(
  [
    'password', 'passw0rd', 'p@ssword', 'password1', 'letmein', 'welcome', 'welcome1', 'changeme', 'changeit', 'default',
    'administrator', 'administrator1', 'admin', 'admin1', 'root', 'toor', 'login', 'access', 'secret', 'secrets',
    'qwerty', 'qwertyuiop', 'qwerty123', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'zaq1zaq1', 'qazwsx', 'qazwsxedc', '1qaz2wsx',
    '1q2w3e4r', 'abc123', 'abcdef', 'iloveyou', 'monkey', 'dragon', 'baseball', 'football', 'basketball', 'soccer',
    'sunshine', 'princess', 'trustno1', 'superman', 'batman', 'starwars', 'shadow', 'master', 'michael', 'jennifer',
    'jessica', 'hunter', 'computer', 'internet', 'service', 'freedom', 'whatever', 'hello', 'hello123', 'charlie',
    'pepper', 'ginger', 'mustang', 'country', 'kitchen', 'summer', 'winter', 'spring', 'autumn', 'butterfly', 'flower',
    'matrix', 'pokemon', 'taylor', 'thomas', 'corvette', 'ferrari', 'nothing', 'secure', 'security', 'strata',
    'stratademo', 'strata-demo', 'demo', 'demopass', 'test', 'testing', 'testtest', 'user', 'username', 'guest',
    'operator', 'analyst', 'viewer', 'supervisor', 'government', 'military', 'defence', 'defense', 'soldier', 'army',
    'navy', 'airforce', 'marines', 'nato', 'companyname', 'installation', 'control', 'dashboard', 'database', 'system',
    'liverpool', 'arsenal', 'chelsea', 'manchester', 'hockey', 'golf', 'cricket', 'tennis', 'pass', 'passcode',
    'passphrase', 'qwerty1', 'trustno', 'iloveyou1', 'letmein1', 'welcome2', 'monkey1', 'dragon1', 'mynewpassword',
    'newpassword', 'enter', 'open', 'sesame', 'opensesame', 'godzilla', 'jordan', 'ninja', 'access14', 'hacker',
  ],
);

/** The letters of a password, lower case: "Password!2026" and "password" compare as the same word. */
const stem = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** Characters that step up or down by one through the whole password: 123456789012, abcdefghijkl. */
function isRun(s: string): boolean {
  if (s.length < 4) return false;
  const step = s.charCodeAt(1) - s.charCodeAt(0);
  if (Math.abs(step) !== 1) return false;
  for (let i = 1; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== step) return false;
  return true;
}

/** The reasons a password is not acceptable; an empty list means it is. */
export function passwordProblems(password: string, username?: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`at most ${PASSWORD_MAX_LENGTH} characters`);
  const lower = password.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) problems.push('must not contain the account name');
  if (DENYLIST.has(lower) || DENYLIST.has(stem(password))) problems.push('is a common password or word');
  if (/^(.)\1+$/.test(password)) problems.push('must not be one character repeated');
  if (isRun(password)) problems.push('must not be a simple run of characters');
  return problems;
}
