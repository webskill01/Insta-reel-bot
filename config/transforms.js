module.exports = {
  presets: {
    default: {
      description: '3% crop + scale to 1080x1920',
      videoFilters: [
        'crop=iw*0.97:ih*0.97',
        'scale=1080:1920:force_original_aspect_ratio=decrease',
        'pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
        'setsar=1',
      ],
      useFilterComplex: false,
      videoCodec: 'libx264',
      preset: 'medium',
      crf: 23,
      videoBitrate: '4M',
      audioCodec: 'aac',
      audioBitrate: '128k',
      audioSampleRate: 48000,
    },

    zoom: {
      description: '5% zoom-in effect',
      videoFilters: [
        'scale=iw*1.05:ih*1.05',
        'crop=1080:1920',
        'setsar=1',
      ],
      useFilterComplex: false,
      videoCodec: 'libx264',
      preset: 'medium',
      crf: 23,
      videoBitrate: '4M',
      audioCodec: 'aac',
      audioBitrate: '128k',
      audioSampleRate: 48000,
    },

    watermark: {
      description: 'Bottom-right watermark overlay',
      videoFilters: [
        'crop=iw*0.97:ih*0.97',
        'scale=1080:1920:force_original_aspect_ratio=decrease',
        'pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
        'setsar=1',
      ],
      useFilterComplex: true,
      filterComplex: '[0:v]crop=iw*0.97:ih*0.97,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[bg];[bg][1:v]overlay=W-w-20:H-h-20',
      videoCodec: 'libx264',
      preset: 'medium',
      crf: 23,
      videoBitrate: '4M',
      audioCodec: 'aac',
      audioBitrate: '128k',
      audioSampleRate: 48000,
    },
  },

  // Rotate through presets to add variation between uploads
  presetRotation: ['default', 'zoom', 'default'],
};
