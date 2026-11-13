import assert from 'node:assert/strict';
import test from 'node:test';
import {mapPoints,mapTileTemplate,fitMapPoints,mercatorLatitude} from '../dist-gjs/gjs/component-map-model.js';

test('map points preserve complete metadata and coordinates while projecting Mercator safely',()=>{
 const points=mapPoints([{lat:'55.75',lon:'37.6',label:'Москва',popup:'<b>Literal</b>'},{lat:90,lon:200},{lat:'NaN',lon:0},{lat:91,lon:0},{lat:'',lon:0}]);
 assert.equal(points.length,2);assert.deepEqual(points[0],{index:0,lat:55.75,lon:37.6,plotLat:55.75,plotLon:37.6,label:'Москва',popup:'<b>Literal</b>'});
 assert.equal(points[1].lat,90);assert.equal(points[1].lon,200);assert.equal(points[1].plotLat,mercatorLatitude);assert.equal(points[1].plotLon,-160);
 assert.equal(mapPoints(Array.from({length:203},(_,i)=>({lat:0,lon:i,label:String(i)}))).length,203);
});
test('tile templates retain coordinates, normalize standard alternatives and encode spaces',()=>{
 assert.equal(mapTileTemplate('https://{s}.tile.example/{z}/{x}/{y}{r}.png'),'https://a.tile.example/{z}/{x}/{y}.png');
 assert.equal(mapTileTemplate('http://127.0.0.1:8765/tiles/{z}/{x}/{-y}.png'),'http://127.0.0.1:8765/tiles/{z}/{x}/{tmsy}.png');
 assert.equal(mapTileTemplate('https://tiles.example/a b/%7Bz%7D/%7Bx%7D/%7By%7D.png'),'https://tiles.example/a%20b/{z}/{x}/{y}.png');
 assert.equal(mapTileTemplate(undefined),undefined);assert.equal(mapTileTemplate(' '),undefined);
});
test('tile transport excludes non-HTTP sources, remote cleartext and embedded credentials',()=>{
 for(const value of ['file:///tmp/a','javascript:bad()','http://tiles.example/{z}/{x}/{y}','http://localhost.evil/{z}','https://user:secret@tiles.example/{z}','https://tiles.example/{unknown}'])assert.throws(()=>mapTileTemplate(value),value);
});
test('fit uses the shortest longitude arc across the antimeridian',()=>{
 const fit=fitMapPoints(mapPoints([{lat:0,lon:179},{lat:0,lon:-179}]),800,360);
 assert.ok(Math.abs(Math.abs(fit.lon)-180)<1e-9);assert.ok(Math.abs(fit.lat)<1e-9);assert.ok(fit.zoom>=8);
});
test('fit remains finite and bounded for empty, singleton, polar and world datasets',()=>{
 assert.deepEqual(fitMapPoints([],640,360),{lat:0,lon:0,zoom:1});
 assert.deepEqual(fitMapPoints(mapPoints([{lat:0,lon:0}]),640,360),{lat:0,lon:0,zoom:12});
 for(const raw of [[{lat:90,lon:0},{lat:-90,lon:180}],[{lat:0,lon:-180},{lat:0,lon:-90},{lat:0,lon:0},{lat:0,lon:90}]]){const place=fitMapPoints(mapPoints(raw),640,360);assert.ok(Number.isFinite(place.lat)&&Number.isFinite(place.lon));assert.ok(place.zoom>=0&&place.zoom<=19)}
});
