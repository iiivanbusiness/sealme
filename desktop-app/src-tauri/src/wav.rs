//! Splits a recorded chunk into pieces small enough to upload. Both capture
//! backends write the same plain layout: a 44-byte RIFF header followed by
//! interleaved 16-bit PCM.

const HEADER_LEN: usize = 44;

/// Cuts `wav` into consecutive WAVs whose audio data is at most
/// `max_data_bytes` each, on whole frames, so no piece ever splits a stereo
/// sample in half. Anything that isn't laid out the way the capture backends
/// write it comes back untouched, as a single piece.
pub fn split(wav: Vec<u8>, max_data_bytes: usize) -> Vec<Vec<u8>> {
    let Some(header) = wav.get(..HEADER_LEN) else { return vec![wav] };
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[36..40] != b"data" {
        return vec![wav];
    }
    let block_align = u16::from_le_bytes([header[32], header[33]]) as usize;
    if block_align == 0 {
        return vec![wav];
    }
    let max = max_data_bytes - max_data_bytes % block_align;
    let data = &wav[HEADER_LEN..];
    if max == 0 || data.len() <= max {
        return vec![wav];
    }
    data.chunks(max).map(|piece| with_header(header, piece)).collect()
}

fn with_header(header: &[u8], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + data.len());
    out.extend_from_slice(header);
    out[4..8].copy_from_slice(&(36 + data.len() as u32).to_le_bytes());
    out[40..44].copy_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same header both capture backends write: 16 kHz, stereo, 16-bit.
    fn stereo_wav(frames: usize) -> Vec<u8> {
        let data: Vec<u8> = (0..frames * 4).map(|i| i as u8).collect();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&64000u32.to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        wav
    }

    fn data_len(wav: &[u8]) -> usize {
        u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize
    }

    #[test]
    fn leaves_a_small_chunk_alone() {
        let wav = stereo_wav(100);
        assert_eq!(split(wav.clone(), 400), vec![wav]);
    }

    #[test]
    fn splits_on_whole_frames_and_keeps_every_byte() {
        let wav = stereo_wav(100);
        // 150 isn't a multiple of the 4-byte frame, so pieces hold 148 bytes.
        let pieces = split(wav.clone(), 150);
        assert_eq!(pieces.len(), 3);
        assert_eq!(pieces.iter().map(|p| data_len(p)).collect::<Vec<_>>(), vec![148, 148, 104]);
        let mut joined = Vec::new();
        for piece in &pieces {
            assert_eq!(&piece[..4], b"RIFF");
            assert_eq!(u32::from_le_bytes([piece[4], piece[5], piece[6], piece[7]]) as usize, piece.len() - 8);
            assert_eq!(piece.len(), HEADER_LEN + data_len(piece));
            assert_eq!(&piece[8..36], &wav[8..36]);
            joined.extend_from_slice(&piece[HEADER_LEN..]);
        }
        assert_eq!(joined, wav[HEADER_LEN..]);
    }

    #[test]
    fn passes_through_anything_it_doesnt_recognize() {
        assert_eq!(split(Vec::new(), 4), vec![Vec::<u8>::new()]);
        let not_wav = vec![7u8; 500];
        assert_eq!(split(not_wav.clone(), 100), vec![not_wav]);
    }
}
