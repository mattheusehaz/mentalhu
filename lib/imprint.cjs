'use strict';

const { siteShell } = require('./site-shell.cjs');

// Company details checked on 2026-11-23:
// https://www.tht.hu/impresszum/ — registered office and tax number
// https://www.tht.hu/altalanos-szerzodesi-feltetelek/ — full legal name
// https://www.tht.hu/adatvedelmi-nyilatkozat/ — company registration number
// https://www.eceg.hu/ — public company contact email
// The THT terms contain a registration-number typo; the privacy notice gives
// 01-10-140592, corroborated by the Cégcontrol and CompanyWall company records.

function renderImprint() {
  const body = '<main id="tartalom" class="shell imprint-main">'
    + '<nav class="imprint-breadcrumb" aria-label="Morzsanavigáció"><ol>'
    + '<li><a href="/">Főoldal</a></li><li aria-current="page">Impresszum</li>'
    + '</ol></nav>'
    + '<header class="imprint-heading"><h1>Impresszum</h1>'
    + '<p>A MENTÁL.hu üzemeltetője a Proptech Digital Investment Zrt.</p></header>'
    + '<dl class="imprint-company-data">'
    + '<div><dt>Cégnév</dt><dd>Proptech Digital Investment Zártkörűen Működő Részvénytársaság</dd></div>'
    + '<div><dt>Székhely</dt><dd>1162 Budapest, Ferenc utca 2.</dd></div>'
    + '<div><dt>Cégjegyzékszám</dt><dd>01-10-140592</dd></div>'
    + '<div><dt>Adószám</dt><dd>27123197-2-42</dd></div>'
    + '<div><dt>E-mail</dt><dd><a href="mailto:info@proptechdigital.com">info@proptechdigital.com</a></dd></div>'
    + '</dl></main>';

  return siteShell('Impresszum', body, {
    description: 'A MENTÁL.hu üzemeltetőjének, a Proptech Digital Investment Zrt.-nek a cégadatai és elérhetősége.',
    canonical: '/impresszum',
    active: '',
    styles: ['/imprint.css?v=20261123']
  });
}

module.exports = { renderImprint };
