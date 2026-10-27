use crate::Result;

pub fn varint(data: &[u8], at: &mut usize) -> Result<u64> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let byte = *data.get(*at).ok_or("EARTH_PROTOCOL: truncated varint")?;
        *at += 1;
        if shift == 63 && byte > 1 {
            return Err("EARTH_PROTOCOL: varint overflow".into());
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err("EARTH_PROTOCOL: invalid varint".into())
}

