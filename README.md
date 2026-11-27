# BC Parcel Explorer

BC Parcel Explorer is an independent map tool for exploring property boundaries and mapped statutory rights of way (SRWs) in British Columbia. Use it to see how a right of way crosses nearby lots, identify the survey plan associated with a parcel, or bring a neighbourhood’s parcel polygons into QGIS or ArcGIS.

## Explore and export

Choose **Draw a box** and click two opposite corners on the map, or enter the bounding coordinates. The preview highlights SRWs in orange and other mapped interests in purple. Click a polygon to see its parcel details, including the parcel identifier (PID) and plan number where available. For lots, the popup also looks up civic address points inside the boundary.

Choose **Download shapefile (.zip)** to get the full geometry of every parcel that intersects the box, including parcels that extend beyond its edges. Lots and overlapping interests are separate records in the same file. The download uses **NAD83 / UTM** in metres, with the zone determined by the centre of the box.

## Where the data comes from

- **Parcel boundaries and interests.** The Land Title and Survey Authority of British Columbia (LTSA) maintains ParcelMap BC. The Province publishes the public Parcel Fabric dataset under the Open Government Licence – British Columbia. The explorer queries the provincial ArcGIS service for the preview and the BC OpenMaps Web Feature Service (WFS) for the shapefile, using the same selection polygon for both. [Dataset and licence](https://catalogue.data.gov.bc.ca/dataset/parcelmap-bc-parcel-fabric) · [Preview layer](https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/218) · [Download service](https://openmaps.gov.bc.ca/geo/pub/WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW/ows?service=WFS&version=1.0.0&request=GetCapabilities)
- **Street addresses.** The BC Address Geocoder supplies the civic address points shown in lot popups. The match is spatial, so a lot can show several addresses or have no matching point. [BC Address Geocoder](https://digital.gov.bc.ca/bcgov-common-components/bc-address-geocoder/)
- **Basemap.** Esri’s World Topographic Map provides the streets and terrain behind the parcel overlay. [Basemap details and contributors](https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer)

### Reading rights of way

An interest polygon shows the surveyed extent over which a charge may be registered. Older easements and SRWs can be absent from ParcelMap BC. To establish which charges are currently registered against a property, use its PID to look up the title. [LTSA parcel definitions](https://ltsa.ca/products-services/parcelmap-bc/about-parcelmap-bc/) · [Finding information on a title](https://ltsa.ca/property-owners/how-can-i/find-information-on-a-title/)

## Running the tool

The web app is a static site in `docs/`. Serve that folder with GitHub Pages, or run `python -m http.server 8080 --directory docs` for a local preview. The optional Python exporter accepts a bounding box or polygon file and writes BC Albers shapefiles. Install its dependencies with `python -m pip install -r requirements.txt` and run `python pull_parcels.py --help` for usage.
