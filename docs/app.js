"use strict";
const el = id => document.getElementById(id);
const map = L.map("map",{preferCanvas:true});
L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19, attribution: 'Basemap: Esri and <a href="https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer">data contributors</a>'
}).addTo(map);
const bcAlbers = "+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +units=m";
const wfs = "https://openmaps.gov.bc.ca/geo/pub/WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW/ows";
const rest = "https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/218/query";
const names = ["west","south","east","north"];
const statusLine = el("status");
const boxStyle = {color:"#16617b",weight:2,dashArray:"7 5",fill:false,interactive:false};
let box, preview, draft, first, drawing = false, revision = 0;
function endDrawing() {
  drawing = false;
  first = null;
  if (draft) map.removeLayer(draft);
  draft = null;
  el("map").classList.remove("drawing");
  el("draw").textContent = "Draw a box";
  map.doubleClickZoom.enable();
}
function clearSelection() {
  revision++;
  el("download").removeAttribute("href");
  el("export-crs").textContent = "";
  if (box) map.removeLayer(box);
  if (preview) map.removeLayer(preview);
}
function parcelKind(p) {
  if (/statutory\s+(?:row|right)/i.test(p.PARCEL_NAME || "")) return 2;
  return /interest/i.test(p.PARCEL_CLASS || "") ? 1 : 0;
}
// Ray casting in GeoJSON longitude/latitude; inner rings exclude holes.
function insideRing([x,y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax,ay] = ring[i], [bx,by] = ring[j];
    if ((ay > y) !== (by > y) && x < (bx-ax)*(y-ay)/(by-ay)+ax) inside = !inside;
  }
  return inside;
}

async function addressForLot(geometry, bounds) {
  const url = new URL("https://geocoder.api.gov.bc.ca/sites/within.json");
  url.search = new URLSearchParams({
    bbox:bounds.toBBoxString(), locationDescriptor:"parcelPoint",
    excludeUnits:"true", maxResults:"100", outputSRS:"4326"
  });
  const response = await fetch(url,{signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw Error("Address lookup failed");
  const {features} = await response.json();
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const addresses = new Set();
  for (const site of features) {
    if (site.geometry?.type !== "Point" || !site.properties.streetAddress || site.properties.civicNumber == null) continue;
    const point = site.geometry.coordinates;
    if (polygons.some(([outer,...holes]) =>
      insideRing(point,outer) && !holes.some(hole => insideRing(point,hole)))) {
      addresses.add(site.properties.streetAddress);
    }
  }
  return [...addresses].join(" · ") || "No street address found for this lot";
}

function previewQuery() {
  return L.esri.query({url:rest.slice(0,-6),useCors:false,isModern:false});
}
function requestPreview(query, method) {
  return new Promise((resolve,reject)=>{
    const timeout = setTimeout(()=>reject(Error("Preview timed out")),30000);
    query[method]((error,result,raw)=>{
      clearTimeout(timeout);
      if (error || !raw || raw.exceededTransferLimit) reject(error || Error("Incomplete response"));
      else resolve(result);
    });
  });
}
async function select(bounds, zoom) {
  endDrawing();
  clearSelection();
  const current = revision;
  const coords = [bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()];
  names.forEach((key,i) => { el(key).value = coords[i]; });
  box = L.rectangle(bounds,boxStyle).addTo(map);
  if (zoom) map.fitBounds(bounds,{padding:[32,32],maxZoom:18});
  // Give both servers the same polygon in the native parcel CRS.
  const [west,south,east,north] = coords;
  const centreLongitude = (west + east) / 2;
  const zone = Math.floor((centreLongitude + 180) / 6) + 1;
  if (zone < 7 || zone > 11) {
    statusLine.textContent = "Select a box centred in a British Columbia UTM zone (7–11).";
    return;
  }
  const epsg = 26900 + zone;
  el("export-crs").textContent = "NAD83 / UTM zone " + zone + "N (EPSG:" + epsg + ")";
  const corners = [[west,south],[west,north],[east,north],[east,south],[west,south]];
  const ring = corners.map(point => proj4("EPSG:4326",bcAlbers,point));
  const wkt = "POLYGON((" + ring.map(point => point.join(" ")).join(",") + "))";
  const download = new URL(wfs);
  download.search = new URLSearchParams({service:"WFS",version:"1.0.0",request:"GetFeature",
    typeName:"pub:WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW",CQL_FILTER:"INTERSECTS(SHAPE,"+wkt+")",srsName:"EPSG:"+epsg,outputFormat:"SHAPE-ZIP"});
  el("download").href = download.href;
  statusLine.textContent = "Loading parcel preview…";
  try {
    const selectionQuery = previewQuery();
    Object.assign(selectionQuery.params, {
      geometry:{rings:[ring],spatialReference:{wkid:3005}},
      geometryType:"esriGeometryPolygon", inSR:3005, spatialRel:"esriSpatialRelIntersects"
    });
    const matches = await requestPreview(selectionQuery,"ids");
    if (current !== revision) return;
    const ids = matches ?? [];
    const features = [];
    // Small batches also keep JSONP GET URLs below typical length limits.
    const batchSize = 90;
    for (let start = 0; start < ids.length; start += batchSize) {
      statusLine.textContent = `Loading parcels: ${start.toLocaleString()} of ${ids.length.toLocaleString()}…`;
      const batch = ids.slice(start,start + batchSize);
      const query = previewQuery().featureIds(batch)
        .fields(["OBJECTID","PID","PARCEL_NAME","PARCEL_CLASS","PLAN_NUMBER"]);
      const page = await requestPreview(query,"run");
      if (current !== revision) return;
      const returned = new Set(page.features.map(feature => feature.properties.OBJECTID));
      if (page.features.length !== batch.length || !batch.every(id => returned.has(id))) {
        throw Error("Incomplete parcel batch");
      }
      features.push(...page.features);
    }
    const data = {type:"FeatureCollection",features};
    if (current !== revision) return;
    data.features.sort((a,b)=>parcelKind(a.properties)-parcelKind(b.properties));
    preview = L.geoJSON(data,{style:feature=>{
      const k=parcelKind(feature.properties);
      return {color:["#3a745a","#794f9a","#9f5511"][k],fillColor:["#9dcbb4","#a98dc8","#f3a23b"][k],weight:k?3:1,fillOpacity:k ? 0.72 : 0.36};
    },onEachFeature:(feature,layer)=>{
      const p = feature.properties;
      const content = document.createElement("div");
      const details = document.createElement("div");
      details.textContent = [p.PARCEL_NAME,p.PARCEL_CLASS,p.PLAN_NUMBER,p.PID].filter(Boolean).join(" · ");
      content.append(details);
      layer.bindPopup(content);
      if (parcelKind(p) || p.PARCEL_CLASS === "Road") return;
      const address = document.createElement("strong");
      content.prepend(address);
      let lookup;
      layer.on("popupopen",async ()=>{
        address.textContent = "Looking up street address…";
        try {
          lookup ??= addressForLot(feature.geometry,layer.getBounds());
          address.textContent = await lookup;
        } catch {
          lookup = undefined;
          address.textContent = "Street address lookup unavailable";
        }
        if (layer.isPopupOpen()) layer.getPopup().update();
      });
    }}).addTo(map);
    box.bringToFront();
    const count=data.features.length;
    statusLine.textContent=count+" parcel records in preview · "+data.features.filter(f=>parcelKind(f.properties)===2).length+" mapped SRWs";
  } catch {
    if (current===revision) statusLine.textContent="Preview unavailable. You can still request the shapefile directly from BC OpenMaps.";
  }
}
el("draw").onclick=()=>{
  if(drawing){endDrawing();statusLine.textContent="Drawing cancelled.";return;}
  drawing=true;map.doubleClickZoom.disable();el("map").classList.add("drawing");el("draw").textContent="Cancel drawing";
  statusLine.textContent="Click or tap two opposite corners on the map.";
};
map.on("click",e=>{
  if(!drawing)return;
  if(!first){first=e.latlng;draft=L.rectangle([first,first],boxStyle).addTo(map);statusLine.textContent="Select the opposite corner.";return;}
  if(first.lat===e.latlng.lat || first.lng===e.latlng.lng)return;
  select(L.latLngBounds(first,e.latlng),false);
});
map.on("mousemove",e=>{if(drawing && first)draft.setBounds([first,e.latlng]);});
el("bounds").oninput=()=>{endDrawing();clearSelection();statusLine.textContent="Apply coordinates to select the new box.";};
function apply(){
  const [w,s,e,n]=names.map(key=>el(key).valueAsNumber);
  if(!(w>=-180 && e<=180 && s>=-85 && n<=85 && w<e && s<n)){statusLine.textContent="Enter valid coordinates with west below east and south below north.";return;}
  select(L.latLngBounds([s,w],[n,e]),true);
}
el("bounds").onsubmit=e=>{e.preventDefault();apply();};
apply();
