/**
 * Everything the product is called, in one place.
 *
 * The name is still undecided. It appears in the executable, the setup window,
 * the Windows startup entry, the folder under AppData and the connector Claude
 * shows the user — so it lives here rather than being typed in nine places.
 * Changing it later is one edit.
 *
 * The only thing this cannot change retroactively is a code signing
 * certificate, which is issued to a fixed name. Decide before buying one.
 */
export const BRAND = {
  /** Shown to people: window title, connector name, emails. */
  name: 'Verge',

  /** Machine-safe form: folder names, executable, registry keys. Lowercase, no spaces. */
  id: 'verge',

  /** One line, used in the installer and the Claude connector description. */
  tagline: 'Ask your WhatsApp anything',

  /** Shown in the executable's file properties. Same as the product name -
   *  there is no separate company behind it. */
  publisher: 'Verge',

  /** Bumped on release; the updater compares against what the server reports. */
  version: '1.0.0'
}

/** Where the installed product keeps its data, e.g. %APPDATA%\verge */
export function dataDirName () {
  return BRAND.id
}

/** What Claude lists the connector as. */
export function connectorName () {
  return BRAND.id
}
