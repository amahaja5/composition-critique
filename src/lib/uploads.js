const PDF_MAX_BYTES = 50 * 1024 * 1024
const MUSICXML_MAX_BYTES = 10 * 1024 * 1024

export const COMPOSITION_ASSETS_BUCKET = 'compositions'

const PDF_EXTENSIONS = ['.pdf']
const MUSICXML_EXTENSIONS = ['.musicxml', '.xml', '.mxl']
const PDF_MIME_TYPES = ['application/pdf']
const MUSICXML_MIME_TYPES = [
  'application/xml',
  'text/xml',
  'application/vnd.recordare.musicxml+xml',
  'application/vnd.recordare.musicxml',
  'application/vnd.recordare.musicxml-compressed',
]

export const ACCEPTED_UPLOAD_TYPES = [
  ...PDF_EXTENSIONS,
  ...MUSICXML_EXTENSIONS,
  ...PDF_MIME_TYPES,
  ...MUSICXML_MIME_TYPES,
].join(',')

export function getAssetType(file) {
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()

  if (PDF_EXTENSIONS.some((extension) => name.endsWith(extension)) || PDF_MIME_TYPES.includes(type)) {
    return 'pdf'
  }

  if (
    MUSICXML_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    MUSICXML_MIME_TYPES.includes(type)
  ) {
    return 'musicxml'
  }

  return ''
}

export function validateCompositionFile(file) {
  const assetType = getAssetType(file)

  if (!assetType) {
    return {
      assetType: '',
      error: 'Only PDF, MusicXML, XML, and MXL files are supported.',
    }
  }

  const maxBytes = assetType === 'pdf' ? PDF_MAX_BYTES : MUSICXML_MAX_BYTES
  if (file.size > maxBytes) {
    return {
      assetType,
      error: `${assetType === 'pdf' ? 'PDF' : 'MusicXML'} files must be ${formatLimit(maxBytes)} or smaller.`,
    }
  }

  return {
    assetType,
    error: '',
  }
}

export function safeFilename(filename) {
  return filename.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload'
}

export function buildStoragePath(ownerId, compositionId, assetId, filename) {
  return `user/${ownerId}/compositions/${compositionId}/${assetId}/${filename}`
}

export function getUploadMimeType(file, assetType) {
  const type = file.type.toLowerCase()

  if (assetType === 'pdf') {
    return 'application/pdf'
  }

  if (MUSICXML_MIME_TYPES.includes(type)) {
    return type
  }

  if (file.name.toLowerCase().endsWith('.mxl')) {
    return 'application/vnd.recordare.musicxml-compressed'
  }

  return 'application/xml'
}

export function getUploadBody(file, mimeType) {
  if (file.type.toLowerCase() === mimeType) {
    return file
  }

  return new Blob([file], { type: mimeType })
}

function formatLimit(bytes) {
  return `${Math.floor(bytes / 1024 / 1024)} MB`
}
