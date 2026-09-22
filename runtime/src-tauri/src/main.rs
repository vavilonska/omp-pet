#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    omp_pet_runtime_lib::run();
}
