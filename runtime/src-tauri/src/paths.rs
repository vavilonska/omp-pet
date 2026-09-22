use std::path::PathBuf;

pub fn data_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("OMP_PET_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }

    #[cfg(target_os = "windows")]
    {
        let home =
            home_dir().ok_or_else(|| "Cannot determine the user profile directory".to_owned())?;
        // LocalAppData is virtualized for MSIX-hosted callers. A directory under
        // the OMP home keeps external and packaged launch contexts consistent.
        return Ok(home.join(".omp").join("omp-pet"));
    }

    #[cfg(target_os = "macos")]
    {
        let home = home_dir().ok_or_else(|| "Cannot determine the home directory".to_owned())?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("oh-my-pi")
            .join("omp-pet"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|path| path.join(".local").join("share")))
            .ok_or_else(|| "Cannot determine the user data directory".to_owned())?;
        Ok(base.join("oh-my-pi").join("omp-pet"))
    }
}

pub fn descriptor_path(data_root: &PathBuf) -> Result<PathBuf, String> {
    let Some(runtime_id) = std::env::var("OMP_PET_RUNTIME_ID")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        return Ok(data_root.join("runtime.json"));
    };
    if runtime_id.len() > 96
        || !runtime_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'))
    {
        return Err("OMP_PET_RUNTIME_ID contains unsupported characters".to_owned());
    }
    let runtimes = data_root.join("runtimes");
    std::fs::create_dir_all(&runtimes).map_err(|error| error.to_string())?;
    Ok(runtimes.join(format!("{runtime_id}.json")))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
}
