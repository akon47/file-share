<template>
  <main class="container container-legal page">
    <article class="legal">
      <header class="legal-head">
        <h1>이용약관</h1>
        <p class="muted">
          file-share(fileshare.kimhwan.com, 이하 "이 서비스")는 개인이 취미로 만들어 무료로 운영하는 파일 전송
          서비스입니다. 이 서비스를 쓰면 아래 내용에 동의한 것으로 봅니다.
        </p>
        <p class="subtle small">2026년 11월 19일 시행</p>
      </header>

      <section>
        <h2>1. 이 서비스가 하는 일</h2>
        <ul>
          <li>
            브라우저끼리 직접(P2P) 연결해서 파일을 보내도록 돕습니다. 서버는 두 기기를 이어 주기만 하고, 파일은 서버를
            거치지 않으며 어디에도 저장되지 않습니다.
          </li>
          <li>운영자는 주고받는 파일의 이름이나 내용을 볼 수 없습니다.</li>
        </ul>
      </section>

      <section>
        <h2>2. 보내면 안 되는 것</h2>
        <p>아래 파일이나 행위는 금지합니다. 법을 어기는 이용의 책임은 그 이용자에게 있습니다.</p>
        <ul>
          <li>저작권·상표권 등 다른 사람의 권리를 침해하는 파일 (허락받지 않은 영화·음악·소프트웨어 등)</li>
          <li>불법촬영물, 아동·청소년 성착취물, 그 밖에 법으로 유통이 금지된 정보</li>
          <li>악성코드나 다른 사람의 기기를 해치는 파일</li>
          <li>당사자의 동의 없이 모은 다른 사람의 개인정보</li>
          <li>원치 않는 사람에게 반복해서 보내기 요청을 보내는 등 다른 이용자를 괴롭히는 행위</li>
          <li>자동화된 대량 접속 등 서비스 운영을 방해하는 행위</li>
        </ul>
      </section>

      <section>
        <h2>3. 책임</h2>
        <ul>
          <li>보낸 파일과 그 전송에 대한 책임은 보낸 사람에게 있습니다.</li>
          <li>받는 사람은 모르는 사람이 보낸 파일을 함부로 열지 말고, 출처를 확인해 주세요.</li>
          <li>
            이 서비스는 있는 그대로 무료로 제공되며, 전송 실패·지연이나 서비스 중단으로 생긴 손해는 운영자의 고의나
            중대한 과실이 없는 한 책임지지 않습니다.
          </li>
        </ul>
      </section>

      <section>
        <h2>4. 이용 제한과 서비스 변경</h2>
        <ul>
          <li>이 약관을 어기거나 서비스 운영을 방해하는 접속은 미리 알리지 않고 차단할 수 있습니다.</li>
          <li>서비스 내용은 바뀌거나 중단될 수 있습니다.</li>
          <li>약관이 바뀌면 이 페이지에 시행일과 바뀐 내용을 적어 알립니다.</li>
        </ul>
      </section>

      <section>
        <h2>5. 신고·문의</h2>
        <p>
          이 서비스가 불법으로 이용되는 것을 알게 되었거나 궁금한 점이 있으면
          <a href="mailto:akon47@naver.com">akon47@naver.com</a>으로 알려 주세요. 개인정보에 관한 내용은
          <RouterLink to="/privacy">개인정보처리방침</RouterLink>에 있습니다.
        </p>
      </section>
    </article>
  </main>
</template>

<style src="@/css/legal.css"></style>
