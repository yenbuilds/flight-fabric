'use strict';

type RunwayCsvIndexes = {
  airport_ident: number;
  le_ident: number;
  he_ident: number;
  le_lat: number;
  le_lon: number;
  he_lat: number;
  he_lon: number;
  length_ft: number;
  width_ft: number;
  surface: number;
  closed: number;
  le_heading_degT: number;
  he_heading_degT: number;
  le_displaced_threshold_ft: number;
  he_displaced_threshold_ft: number;
};

function getRunwayCsvIndexes(headers: string[]): RunwayCsvIndexes {
  return {
    airport_ident: headers.indexOf('airport_ident'),
    le_ident: headers.indexOf('le_ident'),
    he_ident: headers.indexOf('he_ident'),
    le_lat: headers.indexOf('le_latitude_deg'),
    le_lon: headers.indexOf('le_longitude_deg'),
    he_lat: headers.indexOf('he_latitude_deg'),
    he_lon: headers.indexOf('he_longitude_deg'),
    length_ft: headers.indexOf('length_ft'),
    width_ft: headers.indexOf('width_ft'),
    surface: headers.indexOf('surface'),
    closed: headers.indexOf('closed'),
    le_heading_degT: headers.indexOf('le_heading_degT'),
    he_heading_degT: headers.indexOf('he_heading_degT'),
    le_displaced_threshold_ft: headers.indexOf('le_displaced_threshold_ft'),
    he_displaced_threshold_ft: headers.indexOf('he_displaced_threshold_ft'),
  };
}

module.exports = {
  getRunwayCsvIndexes,
};

export {};
