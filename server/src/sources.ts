/** Validation of user-supplied torrent sources. */

const BTIH = /^urn:bt(ih:([a-f0-9]{40}|[a-z2-7]{32})|mh:1220[a-f0-9]{64})$/i;

export function parseMagnet(input: string): { infoHash: string; name: string | null } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Not a valid magnet URI');
  }
  if (url.protocol !== 'magnet:') throw new Error('Only magnet: URIs are accepted');
  const xt = url.searchParams.getAll('xt').find((value) => BTIH.test(value));
  if (!xt) throw new Error('Magnet URI must contain a BitTorrent xt=urn:btih: or urn:btmh: hash');
  return { infoHash: xt.split(':').pop()!.toLowerCase(), name: url.searchParams.get('dn') };
}

/** Basic sanity check: a .torrent file is a bencoded dictionary containing an info dict. */
export function checkTorrentBytes(bytes: Buffer, maxBytes: number): void {
  if (bytes.length === 0) throw new Error('Torrent file is empty');
  if (bytes.length > maxBytes) throw new Error(`Torrent file is larger than ${maxBytes} bytes`);
  if (bytes[0] !== 0x64 /* d */ || !bytes.includes(Buffer.from('4:info'))) {
    throw new Error('File is not a valid .torrent (bencoded dictionary with info)');
  }
}
