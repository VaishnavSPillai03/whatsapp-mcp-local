/**
 * Turning a Baileys message object into the flat {text, mediaType} pair we store.
 * WhatsApp has a lot of message shapes; this covers the ones that actually show
 * up in a normal chat and degrades to a readable placeholder for the rest.
 */

const MEDIA_LABELS = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  contactMessage: 'contact',
  contactsArrayMessage: 'contacts',
  locationMessage: 'location',
  liveLocationMessage: 'live_location',
  pollCreationMessage: 'poll',
  pollCreationMessageV3: 'poll'
}

/** Ephemeral / view-once / caption wrappers nest the real message one level down. */
function unwrap (content) {
  let m = content
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      m.ephemeralMessage ||
      m.viewOnceMessage ||
      m.viewOnceMessageV2 ||
      m.viewOnceMessageV2Extension ||
      m.documentWithCaptionMessage
    if (!inner?.message) return m
    m = inner.message
  }
  return m
}

export function extractContent (message) {
  const m = unwrap(message)
  if (!m) return { text: null, mediaType: null }

  if (m.conversation) return { text: m.conversation, mediaType: null }
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, mediaType: null }

  if (m.imageMessage) return { text: m.imageMessage.caption || null, mediaType: 'image' }
  if (m.videoMessage) return { text: m.videoMessage.caption || null, mediaType: 'video' }
  if (m.documentMessage) {
    return {
      text: m.documentMessage.caption || m.documentMessage.fileName || null,
      mediaType: 'document'
    }
  }
  if (m.audioMessage) {
    return { text: null, mediaType: m.audioMessage.ptt ? 'voice_note' : 'audio' }
  }
  if (m.stickerMessage) return { text: null, mediaType: 'sticker' }

  if (m.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lon, name } = m.locationMessage
    return { text: name || `${lat}, ${lon}`, mediaType: 'location' }
  }
  if (m.contactMessage) return { text: m.contactMessage.displayName || null, mediaType: 'contact' }
  if (m.contactsArrayMessage) {
    const names = (m.contactsArrayMessage.contacts || []).map(c => c.displayName).filter(Boolean)
    return { text: names.join(', ') || null, mediaType: 'contacts' }
  }

  const poll = m.pollCreationMessage || m.pollCreationMessageV3
  if (poll) {
    const opts = (poll.options || []).map(o => o.optionName).filter(Boolean)
    const name = poll.name || 'Poll'
    return { text: opts.length ? `${name}: ${opts.join(' | ')}` : name, mediaType: 'poll' }
  }

  if (m.reactionMessage) {
    return { text: m.reactionMessage.text || null, mediaType: 'reaction' }
  }

  // Key rotations, revokes, disappearing-message settings — noise, not conversation.
  if (m.protocolMessage || m.senderKeyDistributionMessage || m.messageContextInfo) {
    return { text: null, mediaType: null, skip: true }
  }

  const known = Object.keys(m).find(k => MEDIA_LABELS[k])
  if (known) return { text: null, mediaType: MEDIA_LABELS[known] }

  return { text: null, mediaType: null, skip: true }
}
