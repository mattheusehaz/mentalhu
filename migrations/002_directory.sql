CREATE TABLE IF NOT EXISTS directory_categories (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '•',
  verification_level TEXT NOT NULL DEFAULT 'general'
    CHECK (verification_level IN ('healthcare','professional','wellness','alternative','education','media','general')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS directory_listings (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'provider'
    CHECK (kind IN ('provider','organization','training','event','media')),
  short_description TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  county TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  online_available BOOLEAN NOT NULL DEFAULT false,
  website_url TEXT NOT NULL DEFAULT '',
  booking_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  price_info TEXT NOT NULL DEFAULT '',
  qualifications TEXT NOT NULL DEFAULT '',
  specialties TEXT NOT NULL DEFAULT '',
  languages TEXT NOT NULL DEFAULT 'Magyar',
  profile_image_id BIGINT REFERENCES media(id) ON DELETE SET NULL,
  logo_image_id BIGINT REFERENCES media(id) ON DELETE SET NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  featured BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending','published','rejected')),
  event_start TIMESTAMPTZ,
  event_end TIMESTAMPTZ,
  source_url TEXT NOT NULL DEFAULT '',
  admin_notes TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_directory_listings_status ON directory_listings(status, featured DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_directory_listings_city ON directory_listings(city);
CREATE INDEX IF NOT EXISTS idx_directory_listings_kind ON directory_listings(kind);

CREATE TABLE IF NOT EXISTS directory_listing_categories (
  listing_id BIGINT NOT NULL REFERENCES directory_listings(id) ON DELETE CASCADE,
  category_id BIGINT NOT NULL REFERENCES directory_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (listing_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_directory_listing_categories_category ON directory_listing_categories(category_id);

CREATE TABLE IF NOT EXISTS directory_submissions (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  category_slugs TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  online_available BOOLEAN NOT NULL DEFAULT false,
  description TEXT NOT NULL DEFAULT '',
  qualifications TEXT NOT NULL DEFAULT '',
  consent BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','accepted','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO directory_categories(slug,name,group_name,description,icon,verification_level,sort_order) VALUES
('pszichologusok','Pszichológusok','Szakmai segítség','Pszichológiai tanácsadással és támogatással foglalkozó szakemberek.','Ψ','professional',10),
('pszichiaterek','Pszichiáterek','Szakmai segítség','Orvosi végzettségű pszichiáter szakorvosok és rendelők.','✚','healthcare',20),
('pszichoterapeutak','Pszichoterapeuták','Szakmai segítség','Pszichoterápiás tevékenységet végző, megfelelő képesítéssel rendelkező szakemberek.','◉','healthcare',30),
('mentalhigienes-szakemberek','Mentálhigiénés szakemberek','Szakmai segítség','Mentálhigiénés támogatást és prevenciót nyújtó szakemberek.','○','professional',40),
('par-es-csaladterapeutak','Pár- és családterapeuták','Szakmai segítség','Párkapcsolati és családi folyamatokkal dolgozó szakemberek.','⌁','professional',50),
('coachok','Coachok','Fejlődés és életvezetés','Life, business, health és egyéb coaching szolgáltatások.','↗','professional',60),
('mediatorok','Mediátorok','Fejlődés és életvezetés','Konfliktuskezelés és közvetítés.','⇄','professional',70),
('karrier-tanacsadok','Karrier-tanácsadók','Fejlődés és életvezetés','Pályaorientáció, karrierváltás és munkahelyi fejlődés.','◇','professional',80),
('dietetikusok','Dietetikusok','Test és jóllét','Táplálkozással és életmóddal foglalkozó szakemberek.','◒','healthcare',90),
('masszorok','Masszőrök','Test és jóllét','Masszázs és relaxációs szolgáltatások.','≈','wellness',100),
('fogaszatok','Fogászatok','Test és jóllét','Fogászati szolgáltatók és rendelők.','◌','healthcare',110),
('joga-es-mozgas','Jóga és mozgás','Test és jóllét','Jóga, testtudat, mozgás és kapcsolódó programok.','△','wellness',120),
('alvas-es-relaxacio','Alvás és relaxáció','Test és jóllét','Alváshoz, relaxációhoz és stresszkezeléshez kapcsolódó szolgáltatások.','☾','wellness',130),
('kineziologusok','Kineziológusok','Alternatív és spirituális','Kineziológiai szolgáltatások. A kategória nem jelent egészségügyi minősítést.','∞','alternative',140),
('asztrologusok','Asztrológusok','Alternatív és spirituális','Asztrológiai szolgáltatások. A kategória nem egészségügyi szolgáltatás.','✦','alternative',150),
('termeszetgyogyaszat','Természetgyógyászat','Alternatív és spirituális','Természetgyógyászati és komplementer szolgáltatások.','❧','alternative',160),
('kepzesek','Képzések','Programok és tudás','Szakmai, önismereti és jólléti képzések.','▤','education',170),
('konferenciak-es-esemenyek','Konferenciák és események','Programok és tudás','Konferenciák, workshopok, csoportok és rendezvények.','◫','education',180),
('magazinok-es-portalok','Magazinok és portálok','Programok és tudás','Mentális egészséggel és jólléttel foglalkozó kiadványok és oldalak.','▧','media',190),
('podcastok-es-konyvek','Podcastok és könyvek','Programok és tudás','Podcastok, könyvek és egyéb tudásforrások.','◍','media',200),
('kozossegek-es-csoportok','Közösségek és csoportok','Programok és tudás','Önismereti, támogató és közösségi csoportok.','◎','general',210)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name,group_name=EXCLUDED.group_name,description=EXCLUDED.description,
  icon=EXCLUDED.icon,verification_level=EXCLUDED.verification_level,sort_order=EXCLUDED.sort_order,updated_at=now();