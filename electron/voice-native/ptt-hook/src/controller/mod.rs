#[cfg(windows)]
mod names;
pub mod reports;
#[cfg(windows)]
pub mod windows;

pub struct Options {
    pub seconds: Option<u32>,
    pub device_path: Option<String>,
    pub continuous: bool,
    pub button: Option<reports::Button>,
    pub on_pause: Box<dyn FnMut(bool) -> Result<(), String>>,
}

pub trait Output {
    fn emit(&mut self, fields: &str) -> Result<(), String>;
}

pub fn json_string(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            c if c.is_control() => output.push_str(&format!("\\u{:04x}", c as u32)),
            c => output.push(c),
        }
    }
    output.push('"');
    output
}
