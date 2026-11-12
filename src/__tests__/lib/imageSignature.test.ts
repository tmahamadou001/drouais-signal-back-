import { describe, it, expect } from 'vitest'
import { imageFormatOf, matchesDeclaredType } from '../../lib/imageSignature.js'

/**
 * Ce qu'un fichier est, par ses premiers octets.
 *
 * `multer` ne contrôle que le type **déclaré par le client**. Un fichier
 * quelconque annoncé `image/jpeg` finissait dans le bucket `photos`, servi par
 * une URL signée d'un an sous notre nom de domaine.
 */

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const gif = () => Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const webp = () =>
  Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]), // "RIFF"
    Buffer.from([0x24, 0x00, 0x00, 0x00]), // taille
    Buffer.from([0x57, 0x45, 0x42, 0x50]), // "WEBP"
  ])

describe('recognising a real image', () => {
  it('names the four formats the app accepts', () => {
    expect(imageFormatOf(jpeg())).toBe('jpeg')
    expect(imageFormatOf(png())).toBe('png')
    expect(imageFormatOf(gif())).toBe('gif')
    expect(imageFormatOf(webp())).toBe('webp')
  })

  it('refuses what is not an image', () => {
    expect(imageFormatOf(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull()
    expect(imageFormatOf(Buffer.from('%PDF-1.7'))).toBeNull()
    expect(imageFormatOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull() // zip
    expect(imageFormatOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
  })

  /** Un fichier tronqué n'est pas une image : on ne devine pas. */
  it('refuses a buffer too short to say', () => {
    expect(imageFormatOf(Buffer.from([0xff]))).toBeNull()
    expect(imageFormatOf(Buffer.alloc(0))).toBeNull()
  })

  /** "RIFF" seul est un conteneur audio ou vidéo, pas une image. */
  it('does not take any RIFF container for a WebP', () => {
    const wav = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from([0x57, 0x41, 0x56, 0x45]), // "WAVE"
    ])

    expect(imageFormatOf(wav)).toBeNull()
  })
})

describe('the declared type must match the content', () => {
  it('accepts an honest file', () => {
    expect(matchesDeclaredType(jpeg(), 'image/jpeg')).toBe(true)
    expect(matchesDeclaredType(png(), 'image/png')).toBe(true)
  })

  /** Un PNG annoncé JPEG trahit un client cassé ou une tentative : on refuse. */
  it('refuses an image that lies about its format', () => {
    expect(matchesDeclaredType(png(), 'image/jpeg')).toBe(false)
  })

  it('refuses a file that is not an image at all', () => {
    expect(matchesDeclaredType(Buffer.from('%PDF-1.7'), 'image/jpeg')).toBe(false)
  })
})
