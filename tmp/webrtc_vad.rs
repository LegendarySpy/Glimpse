#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(dead_code)]
mod bindgen;
use bindgen::*;

pub enum VadMode {
    Quality,
    LowBitrate,
    Aggressive,
    VeryAggressive,
}

pub struct Vad {
    fvad: *mut Fvad
}

impl Vad {
    /// Creates and initializes a VAD instance.
    ///
    /// On success, returns a pointer to the new VAD instance, which should
    /// eventually be deleted using fvad_free().
    ///
    /// Panics in case of a memory allocation error.
    /// 
    /// Returns Err(()) if an invalid sample rate was specified.
    pub fn new(sample_rate: i32) -> Result<Vad, ()> {
        unsafe {
            let fvad: *mut Fvad = fvad_new();
            if fvad == std::ptr::null_mut() { panic!("fvad_new() did not return a valid instance (memory allocation error)"); }
            let mut instance = Vad { fvad };
            instance.set_sample_rate(sample_rate)?;
            Ok(instance)
        }
    }
    

    /// Reinitializes a VAD instance, clearing all state and resetting mode and
    /// sample rate to defaults.
    pub fn reset(&mut self) {
        unsafe {
            fvad_reset(self.fvad);
        }
    }


    /// Sets the input sample rate in Hz for a VAD instance.
    ///
    /// Valid values are 8000, 16000, 32000 and 48000. The default is 8000. Note
    /// that internally all processing will be done 8000 Hz; input data in higher
    /// sample rates will just be downsampled first.
    ///
    /// Returns `Err(())` if sample rate is not valid.
    pub fn set_sample_rate(&mut self, sample_rate: i32) -> Result<(), ()> {
        unsafe {
            match fvad_set_sample_rate(self.fvad, sample_rate) {
                0 => Ok(()),
                _ => Err(()),
            }
        }
    }

    /// Changes the VAD operating ("aggressiveness") mode of a VAD instance.
    ///
    /// A more aggressive (higher mode) VAD is more restrictive in reporting speech.
    /// Put in other words the probability of being speech when the VAD returns 1 is
    /// increased with increasing mode. As a consequence also the missed detection
    /// rate goes up.
    ///
    /// Valid modes are 0 ("quality"), 1 ("low bitrate"), 2 ("aggressive"), and 3
    /// ("very aggressive"). The default mode is 0.
    ///
    /// Returns Ok(()) on success, or Err(()) if the specified mode is invalid.
    pub fn fvad_set_mode(&mut self, mode: VadMode) -> Result<(), ()> {
        let imode;

        match mode {
            VadMode::Quality => imode = 0,
            VadMode::LowBitrate => imode = 1,
            VadMode::Aggressive => imode = 2,
            VadMode::VeryAggressive => imode = 3,
        }

        unsafe {
            match fvad_set_mode(self.fvad, imode) {
                0 => Ok(()),
                _ => Err(())
            }
        }
    }


    
    /// Calculates a VAD decision for an audio frame.
    ///
    /// `frame` is an array of `length` signed 16-bit samples. Only frames with a
    /// length of 10, 20 or 30 ms are supported, so for example at 8 kHz, `length`
    /// must be either 80, 160 or 240.
    ///
    /// Returns              : Ok(true) - (active voice),
    ///                       Ok(false) - (non-active Voice),
    ///                       Err(()) - (invalid frame length).
    pub fn is_voice_segment(&mut self, buffers: &[i16]) -> Result<bool, ()>  {
        let buffer = &buffers[0] as *const i16;

        unsafe {
            match fvad_process(self.fvad, buffer, buffers.len()) {
                1 => Ok(true),
                0 => Ok(false),
                _ => Err(())
            }
        }
    }
}

impl Drop for Vad {
    fn drop(&mut self) {
        unsafe {
            fvad_free(self.fvad);
        }
    }
}