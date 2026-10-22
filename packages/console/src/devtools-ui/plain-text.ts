/**
 * Text from the page, made to read in the order it is stored.
 *
 * Unicode has characters that reverse the direction of everything after
 * them, and a page chooses its own title, its own url and the name it
 * reports. So `acme‮noisses-elitsoh` is drawn as "acmehostile-sessions",
 * and `intranet.corp.example‮gnc.exe` as "intranet.corp.exampleexe.cng":
 * two strings that are not what they look like, in the one part of this
 * window whose whole job is to say which run and which host you are reading.
 * An operator comparing what the console shows against what they expect is
 * comparing against something the page wrote.
 *
 * `<bdi>` is not the answer to this. It isolates a run from the text around
 * it — which is why the user agent column uses one — but a reversing
 * character inside the run still reverses the rest of the run.
 *
 * Replaced with a replacement character rather than dropped: these are not
 * ordinary characters to tidy away, and a name that quietly loses one would
 * match a name that never had it. The mark says something was removed.
 *
 * Only the explicit formatting characters. The implicit direction of Arabic
 * or Hebrew letters is left alone — those are somebody's language, and a
 * console that mangled a Hebrew page's title would be the worse tool.
 */
const REORDERING = /[؜‎‏‪-‮⁦-⁩]/g;

export function plain(text: string): string;
export function plain(text: string | null | undefined): string | null | undefined;
export function plain(text: string | null | undefined): string | null | undefined {
  return typeof text === 'string' ? text.replace(REORDERING, '�') : text;
}
