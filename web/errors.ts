// What the robot's and the dock's error codes mean, in plain words, and how to fix them.
// Keys are python-roborock's error code names (RoborockErrorCode / RoborockDockErrorCode).

export interface ErrorHelp {
  title: string;
  why: string;
  fix: string[];
}

const SUPPORT = "If it keeps happening, contact Roborock support.";

export const ROBOT_ERRORS: Record<string, ErrorHelp> = {
  lidar_blocked: { title: "Laser sensor blocked", why: "Something is covering the round turret on top, or it can't spin.", fix: ["Check nothing is resting on or pressing against the turret.", "Make sure the turret turns freely, and wipe it with a dry cloth.", "Move the robot to an open spot and resume."] },
  bumper_stuck: { title: "Bumper stuck", why: "The front bumper is pressed in and isn't springing back.", fix: ["Tap around the bumper to free it.", "Check nothing is wedged between the bumper and the body.", "Move it to an open spot and resume."] },
  wheels_suspended: { title: "Wheel lifted off the floor", why: "It climbed onto something and a wheel is hanging, or it was picked up.", fix: ["Put it back on flat floor.", "Clear what it climbed on: a cable, a rug edge or a chair base.", "Resume."] },
  cliff_sensor_error: { title: "Drop sensors confused", why: "The sensors underneath think there's a step. Often they're dusty, or it's on a very dark rug.", fix: ["Wipe the cliff sensors underneath with a dry cloth.", "Move it away from stairs and very dark rugs, then resume."] },
  main_brush_jammed: { title: "Main brush jammed", why: "Hair, threads or a cable are wrapped around the main brush.", fix: ["Turn the robot over, unclip the brush cover and lift out the main brush.", "Cut away hair and threads, including at the brush ends.", "Refit it and resume."] },
  side_brush_jammed: { title: "Side brush jammed", why: "Something is tangled in the side brush.", fix: ["Untangle hair or cables from the side brush.", "If needed, take it off and clean the shaft, then refit it."] },
  wheels_jammed: { title: "Wheel jammed", why: "A drive wheel can't turn.", fix: ["Check both main wheels turn freely.", "Remove hair or debris wrapped around them.", "Put it on flat floor and resume."] },
  robot_trapped: { title: "Trapped", why: "It can't find a way out of where it is.", fix: ["Clear what's boxing it in, or carry it to an open spot.", "If it keeps getting stuck there, add a no-go zone (Edit map)."] },
  no_dustbin: { title: "Dust bin missing", why: "The dust bin isn't detected.", fix: ["Insert the dust bin with its filter until it clicks."] },
  strainer_error: { title: "Filter wet or blocked", why: "The dust bin filter is clogged or damp.", fix: ["Take out the filter and tap it clean, or let it dry completely.", "Refit it and resume."] },
  compass_error: { title: "Strong magnetic field", why: "Something magnetic nearby is confusing its sensors.", fix: ["Move it away from magnetic strips, speakers or large metal objects.", "Resume somewhere else."] },
  low_battery: { title: "Battery too low", why: "There isn't enough charge to carry on.", fix: ["Put it on the dock to charge. It resumes once it has enough."] },
  charging_error: { title: "Not charging", why: "It's on the dock but not charging.", fix: ["Wipe the charging contacts on the robot and on the dock.", "Check the dock is plugged in.", "Put it back on the dock."] },
  battery_error: { title: "Battery problem", why: "The battery reported a fault, sometimes from heat.", fix: ["Let it cool down at room temperature, then try again.", SUPPORT] },
  wall_sensor_dirty: { title: "Wall sensor dirty", why: "The side sensor it uses to follow walls is dirty.", fix: ["Wipe the wall sensor on its right side with a dry cloth.", "Resume."] },
  robot_tilted: { title: "Tilted", why: "It's not level.", fix: ["Put it on flat floor and resume."] },
  side_brush_error: { title: "Side brush problem", why: "The side brush isn't turning properly.", fix: ["Check the side brush is fitted and turns freely.", SUPPORT] },
  fan_error: { title: "Suction fan problem", why: "The suction fan isn't running properly.", fix: ["Empty the dust bin and clean the filter.", "Restart the robot.", SUPPORT] },
  dock: { title: "Dock has no power", why: "The dock isn't powered.", fix: ["Check the dock's power cable at both ends, and the socket."] },
  optical_flow_sensor_dirt: { title: "Floor sensor dirty", why: "The small sensor underneath that tracks movement is dirty.", fix: ["Wipe the optical sensor underneath with a dry cloth.", "Resume."] },
  vertical_bumper_pressed: { title: "Wedged under furniture", why: "The top bumper is pressed: it drove under something too low.", fix: ["Free it from under the furniture.", "If it keeps happening there, add a no-go zone (Edit map)."] },
  dock_locator_error: { title: "Can't find the dock", why: "The dock's signal isn't reaching it.", fix: ["Clear about half a metre on each side of the dock.", "Wipe the front of the dock and the robot's sensors."] },
  return_to_dock_fail: { title: "Couldn't get back to the dock", why: "Something blocked its way home.", fix: ["Check the way to the dock and the area around it are clear.", "Carry it to the dock."] },
  nogo_zone_detected: { title: "Inside a no-go zone", why: "It ended up inside a no-go zone or behind an invisible wall.", fix: ["Carry it out of the zone and resume."] },
  invisible_wall_detected: { title: "Behind an invisible wall", why: "It ended up on the wrong side of an invisible wall.", fix: ["Carry it out and resume."] },
  visual_sensor: { title: "Front sensor problem", why: "The front obstacle sensor isn't working properly.", fix: ["Wipe the front sensor window with a dry cloth.", "Restart the robot.", SUPPORT] },
  light_touch: { title: "Wall sensor problem", why: "The wall-following sensor reported a fault.", fix: ["Wipe the wall sensor on its side.", SUPPORT] },
  vibrarise_jammed: { title: "Mop lift jammed", why: "The mop can't lift or lower.", fix: ["Check the mop pads and their mount for tangles.", "Remove and refit the mop pads."] },
  robot_on_carpet: { title: "On a carpet while mopping", why: "It's on carpet with the mop down.", fix: ["Move it off the carpet, or clean that carpet without mopping."] },
  filter_blocked: { title: "Filter blocked", why: "The dust bin filter is clogged.", fix: ["Clean the filter, or replace it if it's worn."] },
  cannot_cross_carpet: { title: "Can't cross a carpet", why: "With the mop down it won't go over this carpet.", fix: ["Move it past the carpet, or add a no-mop zone there (Edit map)."] },
  internal_error: { title: "Internal error", why: "Something went wrong inside the robot.", fix: ["Restart it: hold the power button to turn it off, then on.", SUPPORT] },
  collect_dust_error_3: { title: "Auto-empty problem", why: "The dock couldn't empty the dust bin.", fix: ["Check the dock's dust bag, and the duct from the robot's port, for a blockage."] },
  collect_dust_error_4: { title: "Auto-empty power problem", why: "The dock's emptying unit reported a voltage fault.", fix: ["Unplug the dock for a minute, then plug it back in.", SUPPORT] },
  mopping_roller_1: { title: "Washing roller jammed", why: "The dock's mop washing roller may be jammed.", fix: ["Take out the washing tray, clear any debris and refit it."] },
  mopping_roller_2: { title: "Washing roller jammed", why: "The dock's mop washing roller may be jammed.", fix: ["Take out the washing tray, clear any debris and refit it."] },
  mopping_roller_error_2: { title: "Washing roller not lowered", why: "The dock's washing roller didn't lower properly.", fix: ["Take out the washing tray, check it's seated correctly and refit it."] },
  clear_water_box_hoare: { title: "Check the clean water tank", why: "The clean water tank isn't detected properly.", fix: ["Make sure the clean water tank is in place and pushed all the way in."] },
  dirty_water_box_hoare: { title: "Check the dirty water tank", why: "The dirty water tank isn't detected properly.", fix: ["Empty the dirty water tank and push it back in all the way."] },
  sink_strainer_hoare: { title: "Water filter out of place", why: "The filter in the dock's washing tray isn't seated.", fix: ["Reinstall the filter in the washing tray."] },
  clear_water_box_exception: { title: "Clean water tank empty", why: "There's no clean water for the mop.", fix: ["Refill the clean water tank and put it back."] },
  clear_brush_exception: { title: "Water filter not installed", why: "The dock's water filter isn't fitted correctly.", fix: ["Check the washing tray filter is fitted properly."] },
  clear_brush_exception_2: { title: "Positioning problem", why: "It isn't sitting right on the dock.", fix: ["Lift it off and set it back on the dock."] },
  filter_screen_exception: { title: "Dock water filter dirty", why: "The filter in the dock's washing tray needs cleaning.", fix: ["Take out the washing tray filter, rinse it and refit it."] },
  up_water_exception: { title: "Can't take in water", why: "The dock couldn't draw clean water.", fix: ["Check the clean water tank is full and seated properly."] },
  drain_water_exception: { title: "Can't drain water", why: "The dock couldn't pump out the dirty water.", fix: ["Empty the dirty water tank.", "Clean the washing tray and its drain."] },
  temperature_protection: { title: "Too hot or too cold", why: "It paused to protect itself from the temperature.", fix: ["Let it return to room temperature, then resume."] },
  clean_carousel_exception: { title: "Washing tray problem", why: "The dock's washing tray reported a fault.", fix: ["Take out the washing tray, clean it and refit it."] },
  clean_carousel_water_full: { title: "Washing tray full", why: "Water has collected in the dock's washing tray.", fix: ["Empty and clean the washing tray, then refit it."] },
  water_carriage_drop: { title: "Water module dropped", why: "A water part in the dock isn't seated.", fix: ["Check the dock's water parts are pushed in properly."] },
  check_clean_carouse: { title: "Check the washing tray", why: "The dock's washing tray needs a look.", fix: ["Take out the washing tray, clean it and refit it."] },
  audio_error: { title: "Speaker problem", why: "The speaker reported a fault.", fix: ["Restart the robot.", SUPPORT] },
};

export const DOCK_ERRORS: Record<string, ErrorHelp> = {
  no_dustbin_or_filter: { title: "Dock: dust bag or filter missing", why: "The dock doesn't detect its dust bag or filter.", fix: ["Open the dock lid and check the dust bag (and filter) are fitted."] },
  auto_empty_dock_fan_error: { title: "Dock: emptying fan problem", why: "The dock's emptying fan isn't working.", fix: ["Check the dust bag isn't full, then unplug the dock for a minute.", SUPPORT] },
  duct_blockage: { title: "Dock: dust duct blocked", why: "Dirt is stuck between the robot's bin and the dock's bag.", fix: ["Check the duct in the dock and the port on the robot for a blockage, and clear it."] },
  auto_empty_dock_voltage_error: { title: "Dock: power problem", why: "The dock's emptying unit reported a voltage fault.", fix: ["Unplug the dock for a minute, then plug it back in.", SUPPORT] },
  water_empty: { title: "Dock: clean water tank empty", why: "The dock is out of clean water for the mop.", fix: ["Refill the clean water tank and put it back."] },
  waste_water_tank_full: { title: "Dock: dirty water tank full", why: "The dirty water tank needs emptying.", fix: ["Empty the dirty water tank, rinse it and put it back."] },
  maintenance_brush_jammed: { title: "Dock: cleaning brush jammed", why: "The brush in the dock's washing tray is stuck.", fix: ["Take out the washing tray, clear the brush and refit it."] },
  dirty_tank_latch_open: { title: "Dock: dirty water tank not closed", why: "The dirty water tank's lid or latch is open.", fix: ["Close the dirty water tank's lid properly and push it in."] },
  no_dustbin: { title: "Dock: dust bag missing", why: "There's no dust bag in the dock.", fix: ["Fit a dust bag in the dock."] },
  cleaning_tank_full_or_blocked: { title: "Dock: washing tray full or blocked", why: "Water can't drain from the washing tray.", fix: ["Empty and clean the washing tray and its filter, then refit it."] },
};

/** Help for an error, with a sensible fallback for codes we don't have words for yet. */
export function errorHelp(code: string, dock = false): ErrorHelp {
  const known = (dock ? DOCK_ERRORS : ROBOT_ERRORS)[code];
  if (known) return known;
  const name = code.replace(/_/g, " ");
  return {
    title: `${dock ? "Dock: " : ""}${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    why: "The robot reported this problem.",
    fix: ["Check the robot and the dock for anything stuck or out of place.", "Then mark it fixed below and resume.", SUPPORT],
  };
}
