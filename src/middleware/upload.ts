import multer from 'multer'

// Store files in memory (we'll upload to Supabase Storage right after)
const storage = multer.memoryStorage()

export const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Format de fichier non supporté. Utilisez JPG, PNG, WebP ou GIF.'))
    }
  },
})
