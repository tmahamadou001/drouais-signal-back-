import multer from 'multer'

// Stockage en mémoire uniquement (pas sur disque)
// La photo n'est PAS sauvegardée ici, juste analysée
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    cb(null, allowed.includes(file.mimetype))
  },
})
