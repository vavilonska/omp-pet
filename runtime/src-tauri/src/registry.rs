use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::models::{PetInfo, PetManifest, RuntimeConfig};

const CELL_WIDTH: usize = 192;
const CELL_HEIGHT: usize = 208;
const ATLAS_COLUMNS: usize = 8;

#[derive(Clone, Debug)]
pub struct InstalledPet {
    pub info: PetInfo,
    pub spritesheet: PathBuf,
}

pub struct PetRegistry {
    data_root: PathBuf,
    pets: Vec<InstalledPet>,
    selected_pet_id: Option<String>,
}

impl PetRegistry {
    pub fn load(data_root: PathBuf) -> Result<(Self, RuntimeConfig), String> {
        fs::create_dir_all(data_root.join("pets")).map_err(io_error)?;
        let config = load_config(&data_root);
        let mut registry = Self {
            data_root,
            pets: Vec::new(),
            selected_pet_id: config.selected_pet_id.clone(),
        };
        registry.rescan()?;
        if registry
            .selected_pet_id
            .as_ref()
            .is_none_or(|id| !registry.pets.iter().any(|pet| &pet.info.id == id))
        {
            registry.selected_pet_id = registry.pets.first().map(|pet| pet.info.id.clone());
        }
        registry.apply_selection();
        Ok((registry, config))
    }

    pub fn list(&self) -> Vec<PetInfo> {
        self.pets.iter().map(|pet| pet.info.clone()).collect()
    }

    pub fn selected_pet_id(&self) -> Option<String> {
        self.selected_pet_id.clone()
    }

    pub fn selected(&self) -> Option<&InstalledPet> {
        self.selected_pet_id
            .as_ref()
            .and_then(|id| self.pets.iter().find(|pet| &pet.info.id == id))
    }

    pub fn by_id(&self, id: &str) -> Option<&InstalledPet> {
        self.pets.iter().find(|pet| pet.info.id == id)
    }

    pub fn select(&mut self, id: &str) -> Result<(), String> {
        if !self.pets.iter().any(|pet| pet.info.id == id) {
            return Err(format!("Pet '{id}' is not installed"));
        }
        self.selected_pet_id = Some(id.to_owned());
        self.apply_selection();
        Ok(())
    }

    pub fn select_relative(&mut self, offset: isize) -> Result<(), String> {
        if self.pets.is_empty() {
            return Err("No OMP pets are installed".to_owned());
        }
        let current = self
            .selected_pet_id
            .as_ref()
            .and_then(|id| self.pets.iter().position(|pet| &pet.info.id == id))
            .unwrap_or(0) as isize;
        let length = self.pets.len() as isize;
        let index = (current + offset).rem_euclid(length) as usize;
        self.selected_pet_id = Some(self.pets[index].info.id.clone());
        self.apply_selection();
        Ok(())
    }

    pub fn save_config(&self, events_enabled: bool, debug_enabled: bool) -> Result<(), String> {
        let config = RuntimeConfig {
            selected_pet_id: self.selected_pet_id.clone(),
            events_enabled,
            debug_enabled,
        };
        let contents = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        fs::write(self.data_root.join("config.json"), contents).map_err(io_error)
    }

    pub fn import(&mut self, source: &Path, force: bool) -> Result<String, String> {
        let source = source
            .canonicalize()
            .map_err(|error| format!("Cannot open pet folder: {error}"))?;
        if !source.is_dir() {
            return Err("Import path must be a directory".to_owned());
        }
        let installed = validate_package(&source, false)?;
        let target = self.data_root.join("pets").join(&installed.info.id);
        if target.exists() && !force {
            return Err(format!(
                "Pet '{}' is already installed; add --force to replace it",
                installed.info.id
            ));
        }
        if target.exists() {
            fs::remove_dir_all(&target).map_err(io_error)?;
        }
        fs::create_dir_all(&target).map_err(io_error)?;
        fs::copy(source.join("pet.json"), target.join("pet.json")).map_err(io_error)?;
        let destination_sheet = target.join(&installed.info.spritesheet_path);
        if let Some(parent) = destination_sheet.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::copy(&installed.spritesheet, &destination_sheet).map_err(io_error)?;
        self.rescan()?;
        self.select(&installed.info.id)?;
        Ok(installed.info.id)
    }

    fn rescan(&mut self) -> Result<(), String> {
        let pets_root = self.data_root.join("pets");
        fs::create_dir_all(&pets_root).map_err(io_error)?;
        let mut pets = Vec::new();
        for entry in fs::read_dir(&pets_root).map_err(io_error)? {
            let path = entry.map_err(io_error)?.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(pet) = validate_package(&path, true) {
                pets.push(pet);
            }
        }
        pets.sort_by(|left, right| left.info.id.cmp(&right.info.id));
        self.pets = pets;
        self.apply_selection();
        Ok(())
    }

    fn apply_selection(&mut self) {
        for pet in &mut self.pets {
            pet.info.selected = self.selected_pet_id.as_deref() == Some(&pet.info.id);
        }
    }
}

fn load_config(data_root: &Path) -> RuntimeConfig {
    fs::read(data_root.join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(RuntimeConfig {
            selected_pet_id: None,
            events_enabled: true,
            debug_enabled: false,
        })
}

fn validate_package(root: &Path, selected: bool) -> Result<InstalledPet, String> {
    let manifest_bytes = fs::read(root.join("pet.json"))
        .map_err(|error| format!("Cannot read pet.json in {}: {error}", root.display()))?;
    let manifest: PetManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Invalid pet.json in {}: {error}", root.display()))?;
    validate_manifest(&manifest)?;

    let sheet_relative = Path::new(&manifest.spritesheet_path);
    let spritesheet = root.join(sheet_relative);
    let canonical_root = root.canonicalize().map_err(io_error)?;
    let canonical_sheet = spritesheet
        .canonicalize()
        .map_err(|error| format!("Cannot open spritesheet {}: {error}", spritesheet.display()))?;
    if !canonical_sheet.starts_with(&canonical_root) || !canonical_sheet.is_file() {
        return Err("spritesheetPath must resolve to a file inside the pet folder".to_owned());
    }

    let dimensions = imagesize::size(&canonical_sheet)
        .map_err(|error| format!("Cannot read spritesheet dimensions: {error}"))?;
    let expected_width = CELL_WIDTH * ATLAS_COLUMNS;
    let expected_height = CELL_HEIGHT
        * if manifest.sprite_version_number == 2 {
            11
        } else {
            9
        };
    if dimensions.width != expected_width || dimensions.height != expected_height {
        return Err(format!(
            "Spritesheet must be {expected_width}x{expected_height}; received {}x{}",
            dimensions.width, dimensions.height
        ));
    }

    let revision = fs::metadata(&canonical_sheet)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let info = PetInfo {
        id: manifest.id,
        display_name: manifest.display_name,
        description: manifest.description,
        sprite_version_number: manifest.sprite_version_number,
        spritesheet_path: manifest.spritesheet_path,
        selected,
        revision,
    };
    Ok(InstalledPet {
        info,
        spritesheet: canonical_sheet,
    })
}

fn validate_manifest(manifest: &PetManifest) -> Result<(), String> {
    let id_is_safe = !manifest.id.is_empty()
        && manifest.id.len() <= 64
        && manifest.id.chars().enumerate().all(|(index, value)| {
            value.is_ascii_lowercase()
                || value.is_ascii_digit()
                || (index > 0 && matches!(value, '.' | '_' | '-'))
        });
    if !id_is_safe {
        return Err("id must match [a-z0-9][a-z0-9._-]{0,63}".to_owned());
    }
    if manifest.display_name.trim().is_empty() {
        return Err("displayName is required".to_owned());
    }
    if !matches!(manifest.sprite_version_number, 1 | 2) {
        return Err("spriteVersionNumber must be 1 or 2".to_owned());
    }
    let sheet_path = Path::new(&manifest.spritesheet_path);
    if manifest.spritesheet_path.trim().is_empty()
        || sheet_path.is_absolute()
        || sheet_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("spritesheetPath must be a safe relative path".to_owned());
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}
