/**
 * The site's own icon on a row of the session list, and what stands in when
 * there is not one.
 */
import { useState } from 'react';
import { assetPath } from '@bxconsole/protocol';
import { SiteIcon } from '../../devtools-ui/icons';

/**
 * Through the relay's asset proxy, like every other resource of a debugged
 * page: the site may well be one this browser cannot reach, and after the
 * session ends the icon still comes from the recording.
 */
export function Favicon({ url, sessionId }: { url: string; sessionId: string }) {
  const [failed, setFailed] = useState(false);
  let src = '';
  try {
    // No fallback: a list of recordings must not make this browser call on
    // every origin it has ever seen. Live sessions still fetch through the
    // page, and recorded ones show whatever the run already cached.
    src = assetPath(sessionId, `${new URL(url).origin}/favicon.ico`, { fallback: false });
  } catch {
    return <NoFavicon />;
  }
  if (failed) return <NoFavicon />;
  // contain, so a site whose icon is not square is shown as it is rather than
  // squashed into the 16px box.
  return <img className="session-favicon" src={src} alt="" onError={() => setFailed(true)} />;
}

/** No icon of its own, which is the ordinary case for a recorded run. */
function NoFavicon() {
  return (
    <span className="session-favicon placeholder">
      <SiteIcon />
    </span>
  );
}
