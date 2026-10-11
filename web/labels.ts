// Human wording for the robot's state, modes and messages.

export const STATE_LABEL: Record<string, string> = {
  starting: "Starting", charger_disconnected: "Off the dock", idle: "Ready", remote_control_active: "Remote control",
  cleaning: "Cleaning", returning_home: "Returning to dock", manual_mode: "Manual mode", charging: "Charging",
  charging_problem: "Charging problem", paused: "Paused", spot_cleaning: "Spot cleaning", error: "Needs attention",
  shutting_down: "Shutting down", updating: "Updating firmware", docking: "Docking", going_to_target: "Heading to spot",
  zoned_cleaning: "Cleaning a zone", segment_cleaning: "Cleaning rooms", emptying_the_bin: "Emptying dust bin",
  washing_the_mop: "Washing mop", going_to_wash_the_mop: "Going to wash mop", mapping: "Mapping your home",
  charging_complete: "Fully charged", device_offline: "Offline", locked: "Locked", air_drying_stopping: "Drying mop",
  robot_status_mopping: "Mopping", clean_mop_cleaning: "Cleaning", clean_mop_mopping: "Mopping",
  segment_mopping: "Mopping rooms", segment_clean_mop_cleaning: "Cleaning rooms", segment_clean_mop_mopping: "Mopping rooms",
  zoned_mopping: "Mopping a zone", zoned_clean_mop_cleaning: "Cleaning a zone", zoned_clean_mop_mopping: "Mopping a zone",
  back_to_dock_washing_duster: "Returning to wash mop", patrol: "Patrolling", in_call: "In a call",
  attaching_the_mop: "Attaching mop", detaching_the_mop: "Detaching mop", unknown: "Unknown",
};

export const MODE_LABEL: Record<string, string> = {
  vacuum: "Vacuum", vac_and_mop: "Vac & Mop", mop: "Mop", custom: "Custom", smart_mode: "SmartPlan",
};

export const OPT_LABEL: Record<string, string> = {
  quiet: "Quiet", balanced: "Balanced", turbo: "Turbo", max: "Max", max_plus: "Max+", off: "Off", gentle: "Gentle",
  smart_mode: "Smart", custom: "Custom", custom_water_flow: "Custom", low: "Low", mild: "Mild", medium: "Medium",
  standard: "Standard", high: "High", intense: "Intense", extreme: "Extreme", min: "Min", slight: "Slight",
  moderate: "Moderate", deep: "Deep", deep_plus: "Deep+", fast: "Fast", light: "Light", smart: "Smart",
  super_deep: "Extra deep",
};

// Modes picked through the cleaning-mode switch rather than the chips.
export const HIDDEN_OPTS = new Set(["smart_mode", "custom", "custom_water_flow"]);

export const TANK_WARN: Record<string, string> = {
  out_of_water: "Refill the clean water tank", refill_error: "Clean water refill problem",
  full_not_installed: "Empty the dirty water tank", drain_error: "Dirty water drain problem",
  full: "Dust bag is full", not_installed: "Dust bag missing", empty_not_installed: "Refill cleaning solution",
};

export const DONE: Record<string, string> = {
  start: "Starting a full clean", clean_rooms: "Cleaning the selected rooms", clean_zone: "Zone cleaning started",
  goto: "On its way", pause: "Paused", resume: "Resuming", stop: "Stopped", dock: "Heading back to the dock",
  locate: "Playing the locator sound", empty_bin: "Emptying the dust bin", wash_mop: "Washing the mop",
  dry_start: "Drying the mop", dry_stop: "Stopped drying", resolve_error: "Marked as resolved",
  reset_consumable: "Reset", run_routine: "Routine started", test_volume: "Playing a test sound",
};
